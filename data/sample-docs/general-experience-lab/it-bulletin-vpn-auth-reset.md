# Service Bulletin IT-24B: VPN Loop After Password or MFA Reset

System line: Apex Secure Access clients

## Condition

Some users can browse normally but the VPN client loops back to sign-in after a password reset, MFA reset, or device re-registration.

## Distinguishing pattern

- Internet access works outside the VPN tunnel.
- The sign-in page reappears after successful credentials.
- The issue starts immediately after password or MFA reset.

## Service action

1. Clear cached workplace tokens and stale browser auth state.
2. Re-register the device certificate with the access client.
3. Run the secure access sign-in repair in section IT-318.

## When not to use this bulletin

Do not use this path when VPN sign-in succeeds but calls break on a dock, gateway ping loss appears, or ethernet packet loss starts after docking.