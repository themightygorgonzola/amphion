# Incident 8417: VPN Loop After Forced Password Reset

## User report

The user can browse normal websites, but the secure access client returns to the sign-in page after the company password reset completed. MFA was also reset earlier that morning.

## Resolution

Support cleared stale workplace tokens, removed the old device certificate, and re-registered the device in the access client. VPN connectivity returned immediately after the new trust record was issued.