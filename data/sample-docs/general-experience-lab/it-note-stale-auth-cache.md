# Support Note: Stale Auth Cache After Identity Reset

## Pattern summary

When identity operations reset a password or MFA seed, local workplace tokens and device trust records may survive just long enough to create a clean-looking login loop. Users often report that the internet works fine while the VPN tunnel never establishes.

## Practical reminder

If the complaint starts right after identity reset and off-VPN browsing is normal, clear cached auth state before troubleshooting docks, DNS, or split-tunnel routes.