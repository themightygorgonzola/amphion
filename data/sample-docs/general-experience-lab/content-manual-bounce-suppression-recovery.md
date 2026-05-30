# Email Delivery Manual ED-214: Bounce Suppression Recovery and Domain Review

## Applies to

Newsletter and campaign delivery operations.

## Use this procedure when

- Subscribers stop receiving messages after repeated hard bounces.
- Site links work normally, but campaigns do not land in inboxes.
- Delivery reports show suppression-list or domain reputation issues.

## Procedure

1. Review hard-bounce logs and suppression entries.
2. Clear valid recipients from the suppression list.
3. Re-verify sending domain alignment and reputation.
4. Re-run the campaign to a seed list before full send.

## Not the usual fit for this procedure

If links return 404 after a page rename and the email itself was delivered, use the redirect and slug repair checklist instead.