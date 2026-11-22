"use strict";

/*Default workspaces that users can use to populate an open slot and perform analysis*/
var DEFAULT_WORKSPACES = [
        {
        "title": "Filter Tuning",
        "graphConfig": [
            {
                "fields": [
                    {
                        "name": "gyroRAW[2]",
                        "smoothing": 0,
                        "curve": {
                            "power": 0.25,
                            "outputRange": 1
                        },
                        "default": {
                            "smoothing": 0,
                            "power": 0.25,
                            "outputRange": 1
                        },
                        "color": "#80b1d3",
                        "lineWidth": 1,
                        "grid": false
                    },
                    {
                        "name": "gyroADC[2]",
                        "smoothing": 3000,
                        "curve": {
                            "power": 0.25,
                            "outputRange": 1
                        },
                        "default": {
                            "smoothing": 3000,
                            "power": 0.25,
                            "outputRange": 1
                        },
                        "color": "#80b1d3",
                        "lineWidth": 1,
                        "grid": false
                    }
                ],
                "height": 1,
                "label": "Turn Rate"
            },
            {
                "fields": [
                    {
                        "name": "motor1speed",
                        "smoothing": 0,
                        "curve": {
                            "power": 1,
                            "outputRange": 1
                        },
                        "default": {
                            "smoothing": 0,
                            "power": 1,
                            "outputRange": 1
                        },
                        "color": "#fb8072",
                        "lineWidth": 1,
                        "grid": false
                    }
                ],
                "height": 1,
                "label": "Motor1Speed"
            }
        ]
    },
    {
        "graphConfig": [
            {
                "fields": [
                    {
                        "color": "#ffffb3",
                        "curve": {
                            "outputRange": 1,
                            "power": 0.25
                        },
                        "default": {
                            "outputRange": 1,
                            "power": 0.25,
                            "smoothing": 3000
                        },
                        "grid": false,
                        "lineWidth": 1,
                        "name": "axisP[2]",
                        "smoothing": 3000
                    },
                    {
                        "color": "#bebada",
                        "curve": {
                            "outputRange": 1,
                            "power": 0.25
                        },
                        "default": {
                            "outputRange": 1,
                            "power": 0.25,
                            "smoothing": 3000
                        },
                        "grid": false,
                        "lineWidth": 1,
                        "name": "axisI[2]",
                        "smoothing": 3000
                    },
                    {
                        "color": "#80b1d3",
                        "curve": {
                            "outputRange": 1,
                            "power": 0.25
                        },
                        "default": {
                            "outputRange": 1,
                            "power": 0.25,
                            "smoothing": 3000
                        },
                        "grid": false,
                        "lineWidth": 1,
                        "name": "axisD[2]",
                        "smoothing": 3000
                    },
                    {
                        "color": "#fccde5",
                        "curve": {
                            "outputRange": 1,
                            "power": 0.25
                        },
                        "default": {
                            "outputRange": 1,
                            "power": 0.25,
                            "smoothing": 3000
                        },
                        "grid": false,
                        "lineWidth": 1,
                        "name": "axisF[2]",
                        "smoothing": 3000
                    }
                ],
                "height": 1,
                "label": "PID"
            },
            {
                "fields": [
                    {
                        "color": "#fb8072",
                        "curve": {
                            "outputRange": 1,
                            "power": 0.25
                        },
                        "default": {
                            "outputRange": 1,
                            "power": 0.25,
                            "smoothing": 3000
                        },
                        "grid": false,
                        "lineWidth": 1,
                        "name": "gyroADC[2]",
                        "smoothing": 3000
                    },
                    {
                        "color": "#8dd3c7",
                        "curve": {
                            "outputRange": 1,
                            "power": 0.25
                        },
                        "default": {
                            "outputRange": 1,
                            "power": 0.25,
                            "smoothing": 3000
                        },
                        "grid": false,
                        "lineWidth": 1,
                        "name": "axisPD[2]",
                        "smoothing": 3000
                    },
                    {
                        "color": "#ffffb3",
                        "curve": {
                            "outputRange": 1,
                            "power": 0.25
                        },
                        "default": {
                            "outputRange": 1,
                            "power": 0.25,
                            "smoothing": 0
                        },
                        "grid": false,
                        "lineWidth": 1,
                        "name": "setpoint[2]",
                        "smoothing": 0
                    },
                    {
                        "color": "#bebada",
                        "curve": {
                            "outputRange": 1,
                            "power": 0.25
                        },
                        "default": {
                            "outputRange": 1,
                            "power": 0.25,
                            "smoothing": 3000
                        },
                        "grid": false,
                        "lineWidth": 1,
                        "name": "axisError[2]",
                        "smoothing": 3000
                    }
                ],
                "height": 1,
                "label": "Gyro and Setpoint"
            },
            {
                "fields": [
                    {
                        "name": "mixer[2]",
                        "smoothing": 0,
                        "curve": {
                            "power": 1,
                            "outputRange": 1
                        },
                        "default": {
                            "smoothing": 0,
                            "power": 1,
                            "outputRange": 1
                        },
                        "color": "#b3de69",
                        "lineWidth": 1,
                        "grid": false
                    }
                ],
                "height": 1,
                "label": "Mixer"
            }
        ],
        "title": "Steering Preset"
    },
    {
        "title": "Power Preset",
        "graphConfig": [
            {
                "fields": [
                    {
                        "name": "Vbat",
                        "smoothing": 0,
                        "curve": {
                            "power": 1,
                            "outputRange": 1
                        },
                        "default": {
                            "smoothing": 0,
                            "power": 1,
                            "outputRange": 1
                        },
                        "color": "#b3de69",
                        "lineWidth": 1,
                        "grid": false
                    },
                    {
                        "name": "Ibat",
                        "smoothing": 0,
                        "curve": {
                            "power": 1,
                            "outputRange": 1
                        },
                        "default": {
                            "smoothing": 0,
                            "power": 1,
                            "outputRange": 1
                        },
                        "color": "#8dd3c7",
                        "lineWidth": 1,
                        "grid": false
                    }
                ],
                "height": 1,
                "label": "Main Battery"
            },
            {
                "fields": [
                    {
                        "name": "Vbec",
                        "smoothing": 0,
                        "curve": {
                            "power": 1,
                            "outputRange": 1
                        },
                        "default": {
                            "smoothing": 0,
                            "power": 1,
                            "outputRange": 1
                        },
                        "color": "#fb8072",
                        "lineWidth": 1,
                        "grid": false
                    },
                    {
                        "name": "BecI",
                        "smoothing": 0,
                        "curve": {
                            "power": 1,
                            "outputRange": 1
                        },
                        "default": {
                            "smoothing": 0,
                            "power": 1,
                            "outputRange": 1
                        },
                        "color": "#8dd3c7",
                        "lineWidth": 1,
                        "grid": false
                    }
                ],
                "height": 1,
                "label": "BEC"
            },
            {
                "fields": [
                    {
                        "name": "motor1speed",
                        "smoothing": 0,
                        "curve": {
                            "power": 1,
                            "outputRange": 1
                        },
                        "default": {
                            "smoothing": 0,
                            "power": 1,
                            "outputRange": 1
                        },
                        "color": "#d9d9d9",
                        "lineWidth": 1,
                        "grid": false
                    },
                    {
                        "name": "motor[all]",
                        "smoothing": 5000,
                        "curve": {
                            "power": 1,
                            "outputRange": 1
                        },
                        "default": {
                            "smoothing": 5000,
                            "power": 1,
                            "outputRange": 1
                        },
                        "color": "#fccde5",
                        "lineWidth": 1,
                        "grid": false
                    },
                    {
                        "name": "rcCommand[4]",
                        "smoothing": 0,
                        "curve": {
                            "power": 1,
                            "outputRange": 1
                        },
                        "default": {
                            "smoothing": 0,
                            "power": 1,
                            "outputRange": 1
                        },
                        "color": "#80b1d3",
                        "lineWidth": 1,
                        "grid": false
                    }
                ],
                "height": 1,
                "label": "Motor Speed, Motor and Throttle"
            }
        ]
    },
];
