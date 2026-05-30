# Incident 8462: Packet Loss Only While Docked on Ethernet

## User report

VPN connects successfully, but calls break up and file transfers stall whenever the laptop sits on the USB-C dock. Gateway pings spike and recover as soon as the user undocks.

## Resolution

Support updated the dock NIC firmware, disabled power-saving on the ethernet adapter, and lowered the MTU to match the edge gateway profile. Traffic stabilized without any identity or VPN credential changes.