# Finance Bulletin EX-12C: Mobile Receipt Sync Delay Blocks Reimbursement

## Condition

Corporate card charges import correctly, but reimbursement remains pending because mobile receipts did not attach and manager approval is waiting on missing documentation.

## Distinguishing pattern

- The card feed imported into the expense report.
- Status shows missing receipt or pending attachment.
- The traveler submitted from the mobile app near trip closeout.

## Service action

1. Trigger a receipt sync retry from the image queue.
2. Attach queued receipts manually if needed.
3. Route the report through the receipt exception workflow in EX-410.

## When not to use this bulletin

Do not use this path for duplicate vendor invoices, bank detail mismatches, or PO remittance disputes.