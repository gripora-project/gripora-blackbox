"use strict";

/**
 * FlightAnalysis — a lightweight, self-contained flight-health analysis engine.
 *
 * Takes a single already-loaded FlightLog and produces a plain-language verdict
 * (a handful of status cards) plus a set of "labs" — Power, Battery, Vibration,
 * PID Tracking and Bounce-Back — each with a narrative story and a few key
 * numbers. On Gripora (car) logs only yaw, the steering loop, is graded: roll
 * and pitch setpoints and PID terms always hold zero. This is a scaled-down take on Blackbox_Lab's Labs/Verdict system,
 * adapted to this viewer's simpler, single-flight-in-front-of-you scope.
 *
 * Design notes:
 *  - Every number is computed only over a detected "stable flight" window
 *    (steady, governed hover/cruise), not the whole log, so spool-up/down and
 *    governor-target changes don't skew the numbers.
 *  - Every lab is independently gated: if the log doesn't have the fields it
 *    needs (or too little stable-flight data), it returns status "insufficient"
 *    with an explanatory story instead of guessing or showing NaN.
 */
var FlightAnalysis = (function() {

    var MIN_STABLE_SAMPLES = 100;

    // ------------------------------------------------------------------
    // Small math helpers
    // ------------------------------------------------------------------

    function average(values) {
        if (!values || !values.length) return null;
        var sum = 0;
        for (var i = 0; i < values.length; i++) sum += values[i];
        return sum / values.length;
    }

    function maxOf(values) {
        var max = -Infinity;
        for (var i = 0; i < values.length; i++) if (values[i] > max) max = values[i];
        return max;
    }

    function median(values) {
        if (!values || !values.length) return null;
        var sorted = values.slice(0).sort(function(a, b) { return a - b; });
        var mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    function spread(array, lo, hi) {
        var min = Infinity, max = -Infinity;
        for (var i = lo; i <= hi; i++) {
            if (array[i] < min) min = array[i];
            if (array[i] > max) max = array[i];
        }
        return max - min;
    }

    function pickAtIndexes(array, indexes) {
        var result = new Array(indexes.length);
        for (var i = 0; i < indexes.length; i++) result[i] = array[indexes[i]];
        return result;
    }

    function insufficient(story) {
        return { status: "insufficient", story: story, metrics: [] };
    }

    // ------------------------------------------------------------------
    // Column extraction — read the whole log once into plain arrays keyed
    // by field name, tolerant of fields the log doesn't have.
    // ------------------------------------------------------------------

    var WANTED_FIELDS = [
        "motor1speed", "motor2speed",
        "headspeed", "tailspeed", // pre-rename field names -- still show up in real logs from before the motor1/2speed rename
        "govTarget", "govRequest",
        "setpoint[0]", "setpoint[1]", "setpoint[2]",
        "axisError[0]", "axisError[1]", "axisError[2]",
        "axisSum[0]", "axisSum[1]", "axisSum[2]",
        "gyroADC[0]", "gyroADC[1]", "gyroADC[2]",
        "rcCommand[4]",
        "Vbat", "Ibat",
        "EscV", "EscI", "EscThr", "EscCap",
        "motor[0]",
        "flightModeFlags", "flightModeFlags2"
    ];

    // ------------------------------------------------------------------
    // Flying mask -- which samples are real flight. The stable-flight search
    // and the handling labs only look at these, so armed time on the ground,
    // closed-throttle glides and modes that drive the surfaces without the
    // gyro don't get graded as flight.
    // ------------------------------------------------------------------

    var FLYING_MIN_THROTTLE = 50;   // |rcCommand[4]|: 0..1000, or -1000..1000 around neutral on Gripora
    var BYPASS_MODES = ["GYRO OFF", "SETUP", "MANUAL", "PASSTHROUGH"];
    var LEVELING_MODES = ["ANGLE", "HORIZON", "TRAINER", "ATTHOLD", "GPSRESCUE", "RESCUE", "LOITER", "RTH", "FAILSAFE"];

    function modeBits(names) {
        var table = (typeof FLIGHT_LOG_FLIGHT_MODE_NAME !== "undefined") ? FLIGHT_LOG_FLIGHT_MODE_NAME : [];
        var bits = [];
        for (var i = 0; i < names.length; i++) {
            var bit = table.indexOf(names[i]);
            if (bit >= 0) bits.push(bit);
        }
        return bits;
    }

    // Mode flags as one per-sample boolean array (any of `bits` set), or null
    // when the log has no flags or none of the modes exist for this firmware.
    function modeMask(columns, bits) {
        var flags1 = columns.flightModeFlags, flags2 = columns.flightModeFlags2;
        if (!flags1 || !bits.length) return null;
        var mask = new Array(flags1.length);
        var last1 = null, last2 = null, lastValue = false;
        for (var i = 0; i < flags1.length; i++) {
            var w1 = flags1[i] || 0, w2 = flags2 ? (flags2[i] || 0) : 0;
            if (w1 !== last1 || w2 !== last2) {
                last1 = w1; last2 = w2; lastValue = false;
                for (var b = 0; b < bits.length; b++) {
                    var word = bits[b] < 32 ? w1 : w2;
                    if (Math.floor(word / Math.pow(2, bits[b] % 32)) % 2 === 1) { lastValue = true; break; }
                }
            }
            mask[i] = lastValue;
        }
        return mask;
    }

    function buildModeMasks(columns, n) {
        var armed = modeMask(columns, modeBits(["ARM"]));
        var bypass = modeMask(columns, modeBits(BYPASS_MODES));
        var leveling = modeMask(columns, modeBits(LEVELING_MODES));
        var throttle = columns["rcCommand[4]"];
        var flying = new Array(n);
        for (var i = 0; i < n; i++) {
            // Magnitude: Gripora throttle is signed (below neutral = brake/reverse)
            flying[i] = (!armed || armed[i]) && (!throttle || Math.abs(throttle[i]) > FLYING_MIN_THROTTLE);
        }
        return { flying: flying, bypass: bypass, leveling: leveling };
    }

    function readColumns(flightLog, startTime, endTime) {
        var fieldIndexByName = {};
        var wanted = [];
        for (var i = 0; i < WANTED_FIELDS.length; i++) {
            var idx = flightLog.getMainFieldIndexByName(WANTED_FIELDS[i]);
            if (idx !== undefined) {
                fieldIndexByName[WANTED_FIELDS[i]] = idx;
                wanted.push(WANTED_FIELDS[i]);
            }
        }

        var timeFieldIndex = FlightLogParser.prototype.FLIGHT_LOG_FIELD_INDEX_TIME;
        var chunks = flightLog.getChunksInTimeRange(
            startTime === undefined ? flightLog.getMinTime() : startTime,
            endTime === undefined ? flightLog.getMaxTime() : endTime
        );

        var sampleCount = 0;
        for (var c = 0; c < chunks.length; c++) sampleCount += chunks[c].frames.length;

        var time = new Array(sampleCount);
        var columns = {};
        for (i = 0; i < wanted.length; i++) columns[wanted[i]] = new Array(sampleCount);

        var n = 0;
        for (c = 0; c < chunks.length; c++) {
            var frames = chunks[c].frames;
            for (var f = 0; f < frames.length; f++) {
                var frame = frames[f];
                time[n] = frame[timeFieldIndex] / 1000000; // microseconds -> seconds
                for (i = 0; i < wanted.length; i++) {
                    columns[wanted[i]][n] = frame[fieldIndexByName[wanted[i]]];
                }
                n++;
            }
        }

        return { time: time, columns: columns, sampleCount: sampleCount };
    }

    // ------------------------------------------------------------------
    // Stable-flight-phase detection — a simplified port of Blackbox_Lab's
    // flightPhase.js. Finds steady cruise/level stretches (and, where a
    // speed-governed motor is fitted, steady-governed stretches) so the
    // labs below aren't scored on spool-up/down or target-change transients.
    // ------------------------------------------------------------------

    function movingAverage(values, windowSamples) {
        var n = values.length;
        var result = new Array(n);
        var sum = 0;
        var half = Math.max(1, Math.floor(windowSamples / 2));

        for (var i = 0; i < n; i++) {
            var lo = Math.max(0, i - half), hi = Math.min(n - 1, i + half);
            // Recompute the window sum directly -- simplest correct approach;
            // this only runs once per log load, not per frame render.
            sum = 0;
            for (var k = lo; k <= hi; k++) sum += values[k];
            result[i] = sum / (hi - lo + 1);
        }
        return result;
    }

    function percentile(sortedValues, fraction) {
        var idx = Math.min(sortedValues.length - 1, Math.max(0, Math.floor(fraction * (sortedValues.length - 1))));
        return sortedValues[idx];
    }

    // `flying` (optional, per sample) limits the search to real flight: see
    // buildModeMasks. Samples outside it are never stable, and the calm floor
    // below is taken from flying samples only -- otherwise on an aerobatic
    // flight the calmest 10 % is time on the ground and "stable" means parked.
    function detectStableFlightPhase(time, motorSpeed, governorTarget, gyroActivity, flying) {
        var n = time.length;

        if (n < 50 || time[n - 1] - time[0] <= 0) {
            return { stableIndexes: [], stableSampleCount: 0, reason: "This run is too short to analyze." };
        }

        var hasMotorSpeed = false;
        if (motorSpeed) {
            for (var h = 0; h < n; h++) if (motorSpeed[h] > 500) { hasMotorSpeed = true; break; }
        }
        var hasGovernorTarget = false;
        if (governorTarget) {
            for (var g = 0; g < n; g++) if (governorTarget[g] > 500) { hasGovernorTarget = true; break; }
        }

        var sampleRateHz = n / (time[n - 1] - time[0]);
        var windowSamples = Math.max(1, Math.round(sampleRateHz * 2)); // +-2s

        var candidate = new Array(n);
        var i, lo, hi;
        var basis;

        if (hasMotorSpeed && hasGovernorTarget) {
            // Best case: an actively governed motor gives a direct, precise
            // read on "steady" -- target barely moving, actual speed
            // tracking it closely.
            basis = "motor-speed";

            for (i = 0; i < n; i++) {
                var speed = motorSpeed[i];
                candidate[i] = false;
                if (speed < 500 || governorTarget[i] <= 500) continue;

                lo = Math.max(0, i - windowSamples);
                hi = Math.min(n - 1, i + windowSamples);

                var targetSpread = spread(governorTarget, lo, hi);
                var trackingError = Math.abs(governorTarget[i] - speed) / governorTarget[i];
                candidate[i] = targetSpread < 20 && trackingError <= 0.08;
            }

            // Blank out +-2s windows around governor-target steps
            for (i = 1; i < n; i++) {
                if (Math.abs(governorTarget[i] - governorTarget[i - 1]) > 20) {
                    lo = Math.max(0, i - windowSamples);
                    hi = Math.min(n - 1, i + windowSamples);
                    for (var j = lo; j <= hi; j++) candidate[j] = false;
                }
            }
        } else if (gyroActivity) {
            // The normal case: no governor target logged (Gripora has no
            // governor and doesn't log one), and
            // an ungoverned prop's RPM naturally wanders with throttle/pitch
            // even during smooth, level cruise, so a plateau check on motor
            // speed itself is the wrong signal here regardless of whether
            // motor speed is logged. Airframe motion is the right one: a
            // period where the aircraft is flying level/steady (not actively
            // maneuvering) shows up as a sustained low-and-flat patch on
            // summed |gyro|, which works the same whether or not there's a
            // motor-speed sensor at all.
            basis = "gyro-activity";

            var smoothed = movingAverage(gyroActivity, Math.round(sampleRateHz));
            var sorted = (flying ? smoothed.filter(function(v, k) { return flying[k]; }) : smoothed.slice(0))
                .sort(function(a, b) { return a - b; });
            if (!sorted.length) {
                return { stableIndexes: [], stableSampleCount: 0, reason: "No powered, armed running was found in this log." };
            }
            // Anchor on a low percentile of the *whole* flight as the calm
            // floor -- robust regardless of how much of the flight is spent
            // maneuvering (a high/low percentile split like quiet-vs-busy
            // breaks down when the busy fraction is small, since a "busy"
            // percentile then just lands back in the calm band). A generous
            // multiplicative + absolute margin absorbs normal noise in the
            // calm band without needing a separate busy reference at all.
            var calmFloor = percentile(sorted, 0.1);
            var threshold = calmFloor * 1.8 + 2;

            for (i = 0; i < n; i++) {
                candidate[i] = smoothed[i] <= threshold;
            }
        } else if (hasMotorSpeed) {
            // Last resort: no gyro data to fall back on, so use a plateau
            // check on motor speed itself. Weaker signal for an ungoverned
            // prop (see above), but better than nothing.
            basis = "motor-speed-plateau";

            for (i = 0; i < n; i++) {
                var s = motorSpeed[i];
                candidate[i] = false;
                if (s < 500) continue;

                lo = Math.max(0, i - windowSamples);
                hi = Math.min(n - 1, i + windowSamples);
                candidate[i] = spread(motorSpeed, lo, hi) < Math.max(40, s * 0.03);
            }
        } else {
            return { stableIndexes: [], stableSampleCount: 0, reason: "No motor-speed or gyro data logged, so a steady stretch can't be identified." };
        }

        if (flying) {
            for (i = 0; i < n; i++) candidate[i] = candidate[i] && flying[i];
        }

        // Keep only contiguous runs of >=3s, trimming 3s off each end
        var trimSamples = Math.round(sampleRateHz * 3);
        var minRunSamples = Math.round(sampleRateHz * 3);
        var stableIndexes = [];
        var runStart = null;

        for (i = 0; i <= n; i++) {
            var isStable = i < n && candidate[i];
            if (isStable && runStart === null) {
                runStart = i;
            } else if (!isStable && runStart !== null) {
                var runEnd = i; // exclusive
                if (runEnd - runStart >= minRunSamples) {
                    for (var k = runStart + trimSamples; k < runEnd - trimSamples; k++) stableIndexes.push(k);
                }
                runStart = null;
            }
        }

        return {
            stableIndexes: stableIndexes,
            stableSampleCount: stableIndexes.length,
            sampleRateHz: sampleRateHz,
            basis: basis,
            reason: stableIndexes.length ? null : "No steady stretch of 3s or more was found — try a longer or steadier run."
        };
    }

    // ------------------------------------------------------------------
    // Power / ESC lab
    // ------------------------------------------------------------------

    function analyzeEscLab(ctx) {
        var throttlePct, throttleSource;

        if (ctx.columns.EscThr) {
            throttlePct = ctx.columns.EscThr.map(function(v) { return v / 10; });
            throttleSource = "ESC-reported throttle";
        } else if (ctx.columns["motor[0]"]) {
            // Magnitude: reversible ESC outputs are signed (Gripora brake/reverse below neutral)
            throttlePct = ctx.columns["motor[0]"].map(function(v) { return Math.abs(v) / 10; });
            throttleSource = "motor output (no ESC telemetry logged)";
        } else {
            return insufficient("No ESC or motor output data was logged for this run.");
        }

        if (ctx.stable.stableSampleCount < MIN_STABLE_SAMPLES) return insufficient(ctx.stable.reason);

        var idx = ctx.stable.stableIndexes;
        var throttleStable = pickAtIndexes(throttlePct, idx);
        var avgThrottle = average(throttleStable);
        var headroom = 100 - avgThrottle;

        var saturated = 0;
        for (var i = 0; i < throttleStable.length; i++) if (throttleStable[i] >= 97) saturated++;
        var saturationPercent = (saturated / throttleStable.length) * 100;

        var status = saturationPercent > 2 ? "attention" : headroom < 12 ? "watch" : "good";

        var metrics = [
            { label: "Average throttle", value: avgThrottle.toFixed(1) + "% (" + throttleSource + ")" },
            { label: "Headroom", value: headroom.toFixed(1) + "%" },
            { label: "Time at/near full output", value: saturationPercent.toFixed(1) + "%" }
        ];

        var current = ctx.columns.EscI || ctx.columns.Ibat;
        if (current) {
            var currentStable = pickAtIndexes(current, idx).map(function(v) { return v / 100; });
            metrics.push({ label: "Average current", value: average(currentStable).toFixed(1) + " A (est.)" });
            metrics.push({ label: "Peak current", value: maxOf(currentStable).toFixed(1) + " A (est.)" });
        }

        var story;
        if (status === "good") {
            story = "Throttle (" + throttleSource + ") averaged " + avgThrottle.toFixed(0) +
                "% while running steadily, leaving healthy headroom.";
        } else if (status === "watch") {
            story = "Throttle averaged " + avgThrottle.toFixed(0) + "% while running steadily — headroom is getting thin (" +
                headroom.toFixed(0) + "%).";
        } else {
            story = "Throttle sat at or above 97% for " + saturationPercent.toFixed(1) +
                "% of steady running, with little output left during those periods.";
        }

        return { status: status, story: story, metrics: metrics, saturationPercent: saturationPercent };
    }

    // ------------------------------------------------------------------
    // Battery lab
    // ------------------------------------------------------------------

    function analyzeBatteryLab(ctx, flightLog) {
        var voltageRaw = ctx.columns.Vbat || ctx.columns.EscV;
        if (!voltageRaw) return insufficient("No battery/ESC voltage data was logged for this run.");
        if (ctx.stable.stableSampleCount < MIN_STABLE_SAMPLES) return insufficient(ctx.stable.reason);

        var voltage = voltageRaw.map(function(v) { return v / 100; });
        var idx = ctx.stable.stableIndexes;
        var stableVoltage = pickAtIndexes(voltage, idx);

        var cellCount = flightLog.getNumCellsEstimate();
        if (!cellCount) cellCount = Math.max(1, Math.round(voltage[0] / 4.1));

        var minV = Math.min.apply(null, stableVoltage);
        var startV = voltage[0];
        var minVPerCell = minV / cellCount;
        var sagPercent = startV ? ((startV - minV) / startV) * 100 : 0;

        var status = minVPerCell < 3.45 ? "attention" : minVPerCell < 3.6 ? "watch" : "good";

        var story;
        if (status === "good") {
            story = "Pack held up well: lowest voltage while running steadily was " + minV.toFixed(2) + "V (" +
                minVPerCell.toFixed(2) + "V/cell).";
        } else if (status === "watch") {
            story = "The lowest voltage while running steadily was " + minV.toFixed(2) + "V (" + minVPerCell.toFixed(2) +
                "V/cell). Worth watching on future runs — one dip alone doesn't prove the pack is tired.";
        } else {
            story = "Voltage sagged to " + minV.toFixed(2) + "V (" + minVPerCell.toFixed(2) +
                "V/cell) while running steadily — check the matching current draw, and consider the pack's health.";
        }

        return {
            status: status,
            story: story,
            metrics: [
                { label: "Cell count (est.)", value: cellCount + "S" },
                { label: "Start voltage", value: startV.toFixed(2) + "V" },
                { label: "Min voltage (stable)", value: minV.toFixed(2) + "V (" + minVPerCell.toFixed(2) + "V/cell)" },
                { label: "Sag", value: sagPercent.toFixed(1) + "%" }
            ]
        };
    }

    // ------------------------------------------------------------------
    // Vibration lab — reuses the app's own FFT (GraphSpectrumCalc /
    // js/complex.js) restricted to the stable-flight window, so the numbers
    // agree with what the Analyser panel would show for the same time range.
    // ------------------------------------------------------------------

    var GYRO_FIELDS = ["gyroADC[0]", "gyroADC[1]", "gyroADC[2]"];
    var AXIS_NAMES = ["Roll", "Pitch", "Yaw"];
    var AXIS_PID_FIELDS = ["rollPID", "pitchPID", "yawPID"];

    function car(sysConfig) {
        return sysConfig.firmwareType === FIRMWARE_TYPE_GRIPORA;
    }

    // Axes the PID labs grade, by name: on Gripora only yaw is stabilised, as the
    // steering loop, so roll and pitch (always zero) are left out.
    function axisNames(sysConfig) {
        return car(sysConfig) ? [null, null, "Steering"] : AXIS_NAMES;
    }

    function classifyVibrationSource(peakHz, motorSpeedRpm) {
        if (!motorSpeedRpm) return "not clearly linked to motor speed (no motor-speed data to compare against)";
        var revHz = motorSpeedRpm / 60;
        var ratio = peakHz / revHz;
        function near(target) { return Math.abs(ratio - target) <= target * 0.12 + 0.15; }
        if (near(1)) return "1x motor/prop speed (balance)";
        if (near(2)) return "2x motor/prop speed (e.g. 2-blade prop pass)";
        if (near(3)) return "3x motor/prop speed";
        if (ratio > 3 && ratio <= 6.5) return "a higher harmonic of motor speed";
        if (ratio > 6.5) return "high frequency — likely motor/bearing noise";
        return "not clearly linked to motor speed (electrical or chassis resonance)";
    }

    function findSpectrumPeak(fftData) {
        if (!fftData || !fftData.fftOutput || !fftData.fftLength) return null;

        // Same bin -> Hz convention the app's own Analyser plot uses (see
        // graph_spectrum_calc.js's _normalizeFft / graph_spectrum_plot.js),
        // so these numbers agree with what's shown there for the same window.
        var maxFrequency = fftData.blackBoxRate / 2;
        var hzPerBin = maxFrequency / fftData.fftLength;
        var minBin = Math.max(1, Math.round(20 / hzPerBin)); // skip DC / very-low-frequency

        var bestBin = -1, bestMag = -Infinity;
        for (var i = minBin; i < fftData.fftOutput.length && i < fftData.fftLength; i++) {
            if (fftData.fftOutput[i] > bestMag) { bestMag = fftData.fftOutput[i]; bestBin = i; }
        }
        if (bestBin < 0) return null;

        return { hz: bestBin * hzPerBin, magnitude: bestMag };
    }

    function analyzeVibrationLab(ctx, flightLog) {
        var haveGyro = false;
        for (var g = 0; g < GYRO_FIELDS.length; g++) if (ctx.columns[GYRO_FIELDS[g]]) haveGyro = true;
        if (!haveGyro) return insufficient("No gyro data was logged for this run.");
        if (ctx.stable.stableSampleCount < MIN_STABLE_SAMPLES) return insufficient(ctx.stable.reason);

        var idx = ctx.stable.stableIndexes;
        var stableStartUs = ctx.time[idx[0]] * 1000000;
        var stableEndUs = ctx.time[idx[idx.length - 1]] * 1000000;

        var motorSpeedAtWindow = ctx.columns.motor1speed ? average(pickAtIndexes(ctx.columns.motor1speed, idx)) : null;

        var identityCurve = { lookupRaw: function(v) { return v; } };

        GraphSpectrumCalc.initialize(flightLog, flightLog.getSysConfig());
        GraphSpectrumCalc.setInTime(stableStartUs);
        GraphSpectrumCalc.setOutTime(stableEndUs);

        var results = [];
        var worstMagnitude = -Infinity, worstAxis = null, worstHz = null;

        for (var axis = 0; axis < 3; axis++) {
            var fieldName = GYRO_FIELDS[axis];
            var fieldIndex = flightLog.getMainFieldIndexByName(fieldName);
            if (fieldIndex === undefined) continue;

            GraphSpectrumCalc.setDataBuffer({ fieldIndex: fieldIndex, curve: identityCurve, fieldName: fieldName });

            var fftData;
            try {
                fftData = GraphSpectrumCalc.dataLoadFrequency();
            } catch (e) {
                continue;
            }

            var peak = findSpectrumPeak(fftData);
            if (!peak) continue;

            results.push({ axis: AXIS_NAMES[axis], hz: peak.hz, source: classifyVibrationSource(peak.hz, motorSpeedAtWindow) });
            if (peak.magnitude > worstMagnitude) {
                worstMagnitude = peak.magnitude;
                worstAxis = AXIS_NAMES[axis];
                worstHz = peak.hz;
            }
        }

        if (!results.length) return insufficient("Could not compute a vibration spectrum for this run.");

        // No good/watch/attention verdict here, and no numeric filter cutoff
        // recommendation — only the strongest peak per axis and what it's
        // likely linked to. See the plan's scope notes for why.
        var story = "Strongest vibration is on " + worstAxis + " at " + worstHz.toFixed(1) + " Hz — " +
            classifyVibrationSource(worstHz, motorSpeedAtWindow) +
            ". Open the Analyser (top toolbar) around this part of the run to look closer.";

        return {
            status: "info",
            story: story,
            metrics: results.map(function(r) { return { label: r.axis + " peak", value: r.hz.toFixed(1) + " Hz — " + r.source }; })
        };
    }

    // ------------------------------------------------------------------
    // PID tracking lab (lightweight — see plan's scope notes: this is a
    // simplified RMS-tracking-error + PID-sum-saturation check, not a full
    // step-response/overshoot/ringing analysis).
    // ------------------------------------------------------------------

    // PID tracking is graded on the step response (js/graph_stepresponse_calc.js)
    // over the analysed range: how far each axis settles from the commanded rate,
    // using only windows that measure the rate loop (see that file). Calm-flight
    // error ratios were tried first and divided gust error by stick inputs of a
    // few deg/s, reporting 100 %+ errors on a well-tuned model.
    var TRACKING_GOOD = 0.2;    // |settled - 1| up to this is good
    var TRACKING_WATCH = 0.35;  // up to this is worth watching, beyond is attention
    var F_GAIN_MIN = 50;        // Gripora's minimum F (PID_F_GAIN_MIN)
    var TRACKING_MIN_WINDOWS = 30;              // fewer step-response windows than this aren't graded
    var TRACKING_PLAUSIBLE = [0.3, 3];          // a settled value outside this isn't a tracking result
    var F_ADVICE_RANGE = [0.5, 2];              // only suggest an F change inside this

    function analyzePidLab(ctx, flightLog) {
        var sysConfig = flightLog.getSysConfig();
        var step = ctx.stepResponse;
        if (!step) return insufficient("No setpoint/gyro tracking data was logged for this run.");

        var idx = ctx.stable.stableIndexes;
        var pidSumLimit = { 0: sysConfig.pidSumLimit, 1: sysConfig.pidSumLimit, 2: sysConfig.pidSumLimitYaw };
        var pidFields = ["rollPID", "pitchPID", "yawPID"];

        var axisResults = [];
        var worstDeviation = -1, worstAxis = null, worstSettled = null, worstF = null;
        var worstSaturationPercent = 0, saturatedAxis = null;
        var ungraded = [];
        var names = axisNames(sysConfig);

        for (var axis = 0; axis < 3; axis++) {
            if (!names[axis]) continue;
            var axisStep = step[["roll", "pitch", "yaw"][axis]];
            var settled = null;
            if (axisStep && axisStep.windowCount > 0) {
                var rate = 1 / (axisStep.time[1] - axisStep.time[0]);
                settled = average(Array.prototype.slice.call(axisStep.response, Math.round(0.3 * rate)));
            }
            var graded = axisStep && axisStep.valid && settled !== null &&
                axisStep.windowCount >= TRACKING_MIN_WINDOWS &&
                settled >= TRACKING_PLAUSIBLE[0] && settled <= TRACKING_PLAUSIBLE[1];
            if (!graded) {
                ungraded.push(names[axis]);
            } else if (Math.abs(settled - 1) > worstDeviation) {
                worstDeviation = Math.abs(settled - 1);
                worstAxis = names[axis];
                worstSettled = settled;
                var pid = sysConfig[pidFields[axis]];
                worstF = pid && pid[3] ? pid[3] : null;
            }

            var saturationPercent = null;
            var sumField = ctx.columns["axisSum[" + axis + "]"];
            var limit = pidSumLimit[axis];
            if (sumField && limit && idx.length) {
                var sumStable = pickAtIndexes(sumField, idx);
                var saturated = 0;
                for (var s = 0; s < sumStable.length; s++) if (Math.abs(sumStable[s]) >= limit * 0.98) saturated++;
                saturationPercent = (saturated / sumStable.length) * 100;
                if (saturationPercent > worstSaturationPercent) {
                    worstSaturationPercent = saturationPercent;
                    saturatedAxis = names[axis];
                }
            }

            axisResults.push({
                axis: names[axis],
                settled: settled,
                valid: !!graded,
                windows: axisStep ? axisStep.windowCount : 0,
                coherence: axisStep ? axisStep.coherence : null,
                saturationPercent: saturationPercent
            });
        }

        if (!worstAxis && !saturatedAxis) {
            return insufficient("Not enough clean stick inputs to judge rate tracking" +
                (ungraded.length ? " (" + ungraded.join(", ") + ": too few windows, or the gyro mostly didn't follow the stick)" : "") + ".");
        }

        var status = "good";
        if (worstDeviation > TRACKING_WATCH || worstSaturationPercent > 5) status = "attention";
        else if (worstDeviation > TRACKING_GOOD || worstSaturationPercent > 1) status = "watch";

        var storyParts = [];
        var action = null;
        if (worstAxis) {
            var percentOfStick = Math.round(worstSettled * 100);
            if (worstDeviation <= TRACKING_GOOD) {
                storyParts.push("Rate tracking is close on every graded axis; " + worstAxis + " is furthest off, settling at " +
                    percentOfStick + "% of the commanded rate.");
            } else {
                storyParts.push(worstAxis + " settles at " + percentOfStick + "% of the commanded rate after a stick input" +
                    (worstSettled < 1 ? ", so the " + (car(sysConfig) ? "car" : "model") + " falls short of the stick." : ", so the " + (car(sysConfig) ? "car" : "model") + " runs ahead of the stick."));
                if (worstF && worstSettled >= F_ADVICE_RANGE[0] && worstSettled <= F_ADVICE_RANGE[1]) {
                    var suggestedF = Math.max(F_GAIN_MIN, Math.round(worstF / worstSettled / 5) * 5);
                    action = (worstSettled < 1 ? "Raise " : "Lower ") + worstAxis + " F from " + worstF + " towards about " + suggestedF +
                        ", then check the Step Response again." +
                        (worstSettled > 1 && suggestedF === F_GAIN_MIN ? " F can't go below " + F_GAIN_MIN + "; lower the rate instead if it's still ahead." : "");
                    storyParts.push(car(sysConfig) ? "F sets most of the steering throw for a commanded rate." : "F sets most of the surface throw for a commanded rate.");
                }
            }
        }
        if (ungraded.length) {
            storyParts.push(ungraded.join(" and ") + " not graded: too few clean stick inputs, or the gyro mostly didn't follow the stick.");
        }
        if (saturatedAxis && worstSaturationPercent > 1) {
            storyParts.push(saturatedAxis + "'s PID sum sat near its configured limit for " +
                worstSaturationPercent.toFixed(1) + "% of steady running — the controller had little headroom left there.");
        }

        return {
            status: status,
            story: storyParts.join(" "),
            action: action,
            metrics: axisResults.map(function(r) {
                return {
                    label: r.axis + " tracking",
                    value: (r.settled !== null && r.valid
                        ? "settles at " + Math.round(r.settled * 100) + "% (" + r.windows + " windows, coherence " + r.coherence.toFixed(2) + ")"
                        : "not graded") +
                        (r.saturationPercent !== null ? ", " + r.saturationPercent.toFixed(1) + "% saturated" : "")
                };
            })
        };
    }

    // ------------------------------------------------------------------
    // Bounce-back lab -- how far the model swings back past level when the
    // stick returns to centre after a roll or loop. Same release detection as
    // the Gripora blackbox skill's bbtune.py.
    // ------------------------------------------------------------------

    var BOUNCE_CENTRE = 5;            // deg/s: stick setpoint counted as centred
    var BOUNCE_MIN_RATE = 60;         // deg/s: stick and gyro peak before release
    var BOUNCE_LOOKBACK_S = 0.4;      // look for the peak this far before release
    var BOUNCE_MIN_QUIET_S = 0.15;    // stick must stay centred at least this long
    var BOUNCE_MAX_QUIET_S = 0.8;     // and the rebound is searched this far
    var BOUNCE_MIN_RELEASES = 5;
    var BOUNCE_WATCH = 0.15;          // median rebound above this is worth watching
    var BOUNCE_ATTENTION = 0.30;

    function findReleases(ctx, axis) {
        var sp = ctx.columns["setpoint[" + axis + "]"], g = ctx.columns["gyroADC[" + axis + "]"];
        if (!sp || !g) return [];
        var n = sp.length, rate = ctx.sampleRateHz;
        var look = Math.round(BOUNCE_LOOKBACK_S * rate), minQuiet = Math.round(BOUNCE_MIN_QUIET_S * rate);
        var maxQuiet = Math.round(BOUNCE_MAX_QUIET_S * rate);
        var usable = ctx.rateLoopSamples;
        var rebounds = [];
        for (var i = look; i < n - maxQuiet; i++) {
            if (!(Math.abs(sp[i]) < BOUNCE_CENTRE && Math.abs(sp[i - 1]) >= BOUNCE_CENTRE)) continue;
            var spPeak = 0;
            for (var j = i - look; j < i; j++) if (Math.abs(sp[j]) > Math.abs(spPeak)) spPeak = sp[j];
            if (Math.abs(spPeak) < BOUNCE_MIN_RATE) continue;
            var dir = spPeak > 0 ? 1 : -1;
            var gPeak = 0;
            for (j = i - look; j < i + Math.round(0.1 * rate); j++) gPeak = Math.max(gPeak, dir * g[j]);
            if (gPeak < BOUNCE_MIN_RATE) continue;
            var quiet = 0;
            while (quiet < maxQuiet && Math.abs(sp[i + quiet]) < BOUNCE_CENTRE) quiet++;
            if (quiet < minQuiet) continue;
            var ok = true;
            for (j = i - look; j < i + quiet && ok; j++) ok = usable[j];
            if (!ok) continue;
            var back = 0;
            for (j = i; j < i + quiet; j++) back = Math.max(back, -dir * g[j]);
            rebounds.push(back / gPeak);
            i += quiet;
        }
        return rebounds;
    }

    function analyzeBounceLab(ctx) {
        var isCar = car(ctx.sysConfig);
        if (!ctx.rateLoopSamples) {
            return insufficient(isCar
                ? "No mode data was logged, so stick releases can't be told apart from GYRO OFF or failsafe."
                : "No flight-mode data was logged, so stick releases can't be told apart from MANUAL or leveling flight.");
        }
        var names = axisNames(ctx.sysConfig);
        var results = [];
        for (var axis = 0; axis < 3; axis++) {
            if (!names[axis]) continue;
            var rebounds = findReleases(ctx, axis);
            if (rebounds.length < BOUNCE_MIN_RELEASES) continue;
            var sorted = rebounds.slice(0).sort(function(a, b) { return a - b; });
            results.push({ axis: names[axis], pidField: AXIS_PID_FIELDS[axis], count: rebounds.length, median: median(rebounds), p75: percentile(sorted, 0.75) });
        }
        if (!results.length) {
            return insufficient(isCar
                ? "Not enough clean stick releases (a turn stopped by centring the steering) to judge bounce-back."
                : "Not enough clean stick releases (a roll or loop stopped by centring the stick) to judge bounce-back.");
        }

        var worst = results.reduce(function(a, b) { return b.median > a.median ? b : a; });
        var status = worst.median > BOUNCE_ATTENTION ? "attention" : worst.median > BOUNCE_WATCH ? "watch" : "good";
        var pct = Math.round(worst.median * 100);
        var story = status === "good"
            ? (isCar ? "Turns stop cleanly: when the steering is centred the car swings back at most " : "Rolls and loops stop cleanly: when the stick is centred the model swings back at most ") +
              pct + "% of its rate (" + worst.axis + ")."
            : worst.axis + " bounces back when the stick is centred: typically " + pct + "% of the rate it was turning at swings the other way.";

        // B (feedforward boost) kicks the surface against the rotation as the stick
        // returns, which is the most direct cure; with it at 0 that comes first.
        var pid = ctx.sysConfig[worst.pidField];
        var B = pid && pid[4] != null ? pid[4] : null;
        var action = null;
        if (status !== "good") {
            action = B === 0
                ? "B is 0 on " + worst.axis + ": set it to about 35 (the current default) so the " + (isCar ? "steering" : "surface") + " kicks against the rotation as the stick returns. Then raise I-Term Relax a step at a time if it still bounces."
                : "Raise I-Term Relax on " + worst.axis + (isCar ? " (Driving Feel)" : " (Flight Feel)") + " a step at a time" +
                  (B != null ? ", or B (now " + B + ")" : "") + ". If neither helps, the rebound is coming from the " + (isCar ? "chassis" : "airframe") + " rather than the controller.";
        }

        return {
            status: status,
            story: story,
            action: action,
            metrics: results.map(function(r) {
                return { label: r.axis + " bounce-back", value: Math.round(r.median * 100) + "% median, " + Math.round(r.p75 * 100) + "% p75 (" + r.count + " releases)" };
            })
        };
    }

    // ------------------------------------------------------------------
    // Verdict — rolls the labs up into up to 5 cards, mirroring
    // Blackbox_Lab's flightVerdict.js card shape.
    // ------------------------------------------------------------------

    function statusRank(status) {
        return status === "attention" ? 2 : status === "watch" ? 1 : 0;
    }

    function cardFromLab(key, title, screen, lab) {
        if (!lab || lab.status === "insufficient" || lab.status === "info") return null;

        var actionByStatus = {
            good: "Nothing to do.",
            watch: "Keep an eye on this over your next few runs.",
            attention: "Worth addressing before your next run."
        };

        return {
            key: key,
            title: title,
            status: lab.status,
            headline: lab.story.split(/(?<=[.!?])\s/)[0],
            detail: lab.story,
            // A lab with a specific fix says so in `action`; the rest get the generic line
            action: (lab.status !== "good" && lab.action) || actionByStatus[lab.status] || "",
            screen: screen
        };
    }

    function buildVerdict(labs) {
        var cards = [
            cardFromLab("esc", "Power", "seekbar", labs.esc),
            cardFromLab("battery", "Battery", "seekbar", labs.battery),
            cardFromLab("pid", "PID Tracking", "seekbar", labs.pid),
            cardFromLab("bounce", "Bounce-Back", "seekbar", labs.bounce)
        ].filter(function(c) { return c; });

        var worst = "good";
        for (var i = 0; i < cards.length; i++) if (statusRank(cards[i].status) > statusRank(worst)) worst = cards[i].status;

        var summary;
        if (!cards.length) {
            summary = "Not enough data in this log to build a verdict — see the notes in each section below.";
        } else if (worst === "attention") {
            summary = "This run has at least one thing worth addressing — see the cards below.";
        } else if (worst === "watch") {
            summary = "This run looks reasonable overall, with a couple of things worth keeping an eye on.";
        } else {
            summary = "This run looks healthy across everything this log lets us check.";
        }

        return { cards: cards, worst: worst, summary: summary };
    }

    // ------------------------------------------------------------------
    // Very large logs (tens of MB+) can take minutes to fully decode --
    // flightLog.getChunksInTimeRange() is a single synchronous, CPU-bound
    // call with no opportunity to yield, and pulling a whole such flight
    // freezes the tab for the duration (the same cost js/csv-exporter.js
    // pays for "export the whole log", just triggered here by default the
    // moment the dialog opens instead of on an explicit user action).
    //
    // Rather than always decoding the entire flight, cap how much we ask
    // for: above MAX_ANALYSIS_DURATION_S, use the per-I-frame activity
    // summary -- already built cheaply at log-open time, no full decode
    // needed -- to find the steadiest (lowest throttle-spread) window of
    // that length, and only decode that slice.
    // ------------------------------------------------------------------

    var MAX_ANALYSIS_DURATION_S = 240;

    function findSteadiestWindow(flightLog, windowSeconds) {
        var summary = flightLog.getActivitySummary();
        if (!summary || !summary.times || !summary.times.length) return null;

        var times = summary.times, throttle = summary.avgThrottle;
        var n = times.length;
        var windowUs = windowSeconds * 1000000;

        var bestSpread = Infinity, bestStart = null;
        var j = 0, min = Infinity, max = -Infinity;

        for (var i = 0; i < n; i++) {
            var endTime = times[i] + windowUs;
            if (endTime > times[n - 1]) break;

            // Advance the window end and track min/max throttle within it
            // (recomputed per start -- summary arrays are small, this stays cheap).
            j = i; min = Infinity; max = -Infinity;
            while (j < n && times[j] <= endTime) {
                if (throttle[j] < min) min = throttle[j];
                if (throttle[j] > max) max = throttle[j];
                j++;
            }

            var spread = max - min;
            if (spread < bestSpread) {
                bestSpread = spread;
                bestStart = times[i];
            }
        }

        return bestStart !== null ? { startTime: bestStart, endTime: bestStart + windowUs } : null;
    }

    // ------------------------------------------------------------------
    // Entry point
    // ------------------------------------------------------------------

    function build(flightLog) {
        var sysConfig = flightLog.getSysConfig();

        var minTime = flightLog.getMinTime(), maxTime = flightLog.getMaxTime();
        var totalDurationS = (maxTime - minTime) / 1000000;

        var analysisWindow = null;
        if (totalDurationS > MAX_ANALYSIS_DURATION_S) {
            analysisWindow = findSteadiestWindow(flightLog, MAX_ANALYSIS_DURATION_S);
            // No usable activity summary (unlikely) -- fall back to just the
            // first MAX_ANALYSIS_DURATION_S rather than the whole flight.
            if (!analysisWindow) analysisWindow = { startTime: minTime, endTime: minTime + MAX_ANALYSIS_DURATION_S * 1000000 };
        }

        var extracted = analysisWindow
            ? readColumns(flightLog, analysisWindow.startTime, analysisWindow.endTime)
            : readColumns(flightLog);

        // Real logs still show up with the pre-rename field names (older
        // firmware builds logged "headspeed"/"tailspeed" before they became
        // "motor1speed"/"motor2speed") -- normalize once here so every lab
        // below just sees motor1speed/motor2speed regardless of which the
        // log actually used.
        if (!extracted.columns.motor1speed && extracted.columns.headspeed) {
            extracted.columns.motor1speed = extracted.columns.headspeed;
        }
        if (!extracted.columns.motor2speed && extracted.columns.tailspeed) {
            extracted.columns.motor2speed = extracted.columns.tailspeed;
        }

        // Used as the primary stable-phase basis whenever there's no
        // governor target logged (the normal case; Gripora has no governor)
        // regardless of whether motor speed itself is present, since an
        // ungoverned prop's RPM isn't a reliable "steady" signal on its own.
        // Summed |gyro| stands in for "is the airframe actively maneuvering
        // right now".
        var gyroActivity = null;
        var gx = extracted.columns["gyroADC[0]"], gy = extracted.columns["gyroADC[1]"], gz = extracted.columns["gyroADC[2]"];
        if (gx && gy && gz) {
            gyroActivity = new Array(extracted.time.length);
            for (var gi = 0; gi < gyroActivity.length; gi++) {
                gyroActivity[gi] = Math.abs(gx[gi]) + Math.abs(gy[gi]) + Math.abs(gz[gi]);
            }
        }

        var n = extracted.time.length;
        var masks = buildModeMasks(extracted.columns, n);

        var stable = detectStableFlightPhase(extracted.time, extracted.columns.motor1speed, extracted.columns.govTarget || extracted.columns.govRequest, gyroActivity, masks.flying);

        // Samples where the rate loop was in charge: flying, no bypass or leveling mode
        var rateLoopSamples = null;
        if (masks.bypass || masks.leveling) {
            rateLoopSamples = new Array(n);
            for (var ri = 0; ri < n; ri++) {
                rateLoopSamples[ri] = masks.flying[ri] && !(masks.bypass && masks.bypass[ri]) && !(masks.leveling && masks.leveling[ri]);
            }
        }

        // Step response over the same range, for PID tracking (see analyzePidLab)
        var stepResponse = null;
        if (typeof StepResponseCalc !== "undefined") {
            StepResponseCalc.initialize(flightLog, sysConfig);
            StepResponseCalc.setInTime(analysisWindow ? analysisWindow.startTime : minTime);
            StepResponseCalc.setOutTime(analysisWindow ? analysisWindow.endTime : maxTime);
            stepResponse = StepResponseCalc.calculate();
        }

        var ctx = {
            time: extracted.time,
            columns: extracted.columns,
            stable: stable,
            masks: masks,
            rateLoopSamples: rateLoopSamples,
            sampleRateHz: n > 1 ? n / ((extracted.time[n - 1] - extracted.time[0]) || 1) : 1,
            stepResponse: stepResponse,
            sysConfig: sysConfig
        };

        var labs = {
            esc: analyzeEscLab(ctx),
            battery: analyzeBatteryLab(ctx, flightLog),
            vibration: analyzeVibrationLab(ctx, flightLog),
            pid: analyzePidLab(ctx, flightLog),
            bounce: analyzeBounceLab(ctx)
        };

        var context = {
            craftName: sysConfig.Craft_name || "Unnamed car",
            firmwareVersion: sysConfig.firmwareVersion || null,
            durationSeconds: totalDurationS,
            stableSeconds: stable.sampleRateHz ? stable.stableSampleCount / stable.sampleRateHz : 0,
            analyzedSeconds: analysisWindow ? (analysisWindow.endTime - analysisWindow.startTime) / 1000000 : totalDurationS,
            capped: !!analysisWindow
        };

        return { context: context, labs: labs, verdict: buildVerdict(labs) };
    }

    return { build: build };
})();
