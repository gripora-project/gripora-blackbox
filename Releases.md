# 0.0.5

First Gripora release of the Blackbox Explorer, for RC cars, at blackbox.gripora.org. WingFlight logs still open.
Read Gripora logs as a car: its debug modes (DRIVE, DRIVE_AIDS), modes, features, failsafe phases and disarm reasons, and the throttle attenuation, speed attenuation, ABS and traction control headers. Steering-only PID rows, with no governor, angle or rotor sections.
Show the throttle signed around neutral in fields, graphs and the stick overlay, with Steering and Throttle as the default graphs. Run Analysis grades the steering.
Label the yaw axis Steering and the yaw gyro turn rate in Gripora logs; other firmware logs keep Yaw.
Show a car in the 3D attitude view.
Fix the frequency against throttle spectrum binning the throttle 10 times too high.
Fix the firmware version being read wrongly from the log header ("Gripora 4.6.0" as 6.0.0).
