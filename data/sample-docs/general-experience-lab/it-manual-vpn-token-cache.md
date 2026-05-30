# IT Manual IT-318: Clear Token Cache and Re-register Secure Access

## Applies to

Apex Secure Access desktop clients.

## Use this procedure when

- VPN sign-in loops after password or MFA reset.
- Device trust prompts reappear even though credentials are accepted.
- Internet access outside the tunnel remains normal.

## Procedure

1. Sign out of the access client.
2. Clear cached tokens and browser workplace sessions.
3. Remove and re-register the device certificate.
4. Sign back in and confirm tunnel establishment.

## Escalate to network diagnostics if

- Gateway ping loss appears only while docked.
- VPN sign-in succeeds but app traffic drops on ethernet.
- Packet loss or MTU problems remain after auth repair.