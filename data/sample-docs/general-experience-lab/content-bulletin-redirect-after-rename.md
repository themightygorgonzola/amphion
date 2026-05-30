# Publishing Bulletin KB-17A: Redirect Setup After Article Rename

## Condition

Internal links and campaign buttons can start returning 404s after a knowledge base article or landing page is renamed without updating slug redirects.

## Distinguishing pattern

- The page was recently renamed or moved.
- Old links fail while the new page loads directly.
- Email buttons and cross-links still point at the previous slug.

## Service action

1. Create redirects from the previous slug to the new path.
2. Rebuild the internal link map.
3. Follow the publish redirect checklist in KB-301.

## When not to use this bulletin

Do not use this path when site links work but newsletter recipients stop receiving mail after hard bounces or suppression events.