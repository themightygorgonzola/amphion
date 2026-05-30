# IT Manual NW-204: Dock Ethernet Packet Loss and Split-Tunnel Instability

## Applies to

Docked laptops using USB-C ethernet adapters or integrated dock NICs.

## Use this procedure when

- VPN sign-in succeeds.
- Teams audio, browser traffic, or file sync breaks only while docked.
- Gateway ping loss or MTU fragmentation appears after docking.

## Procedure

1. Update the dock firmware and network adapter driver.
2. Disable energy-efficient ethernet settings.
3. Re-test with reduced MTU and direct adapter connection.
4. Confirm split-tunnel routes after link stabilization.

## Not the usual fit for this procedure

If internet access remains stable and the loop begins only after password or MFA reset, use token cache repair first.