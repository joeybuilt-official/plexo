# Front-End Engineering

> Applies to the Next.js 16.2.6 / React 19.2 web and Hub clients, shared React UI, and Flutter mobile client.

## Placement

- Route and page entrypoints live under `apps/web/src/app/`.
- Generic React primitives live under `packages/ui/src/components/` and `apps/web/src/components/ui/`.
- Product-aware web components live under `apps/web/src/components/` and route-local `_components/` folders.
- Pages wire data to components and own route loading/error/empty states. Keep business decisions out of them.

## State and data

- Start with local state; lift only to the nearest common parent.
- Server data is not app state. Web uses SWR through `apps/web/src/lib/swr.ts` plus feature clients; keep edits in local state only while a form is in progress.
- No single shared typed API client exists. Server components use `apps/web/src/lib/api-server.ts`; client components use the nearest feature client or `jsonFetcher` from `apps/web/src/lib/swr.ts`. Extend that boundary instead of adding raw fetch logic to reusable components.
- Issue independent requests in parallel; do not create request waterfalls in nested components.
- Mutations invalidate or update affected SWR keys and surface failures.

## Required states

Every asynchronous page, form, upload, and background save has visible loading, empty, and actionable error states. Log failures with operation and record context; never leave a stale spinner or optimistic value after failure.

## Accessibility and performance

- Use real buttons and links; every control has an accessible name and visible focus.
- Meet WCAG AA contrast, do not encode meaning by color alone, and honor reduced motion.
- Give images dimensions and meaningful or empty alt text.
- Virtualize or paginate long lists. Memoize only after measuring a problem.
- Keep effects narrowly scoped with honest dependencies.
