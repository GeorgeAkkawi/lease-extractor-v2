// Query options for the handful of screens whose ANSWER CAN CHANGE WITHOUT THE LANDLORD
// TOUCHING ANYTHING.
//
// George, 2026-08-06: *"does the user have to hard reload the page to see if the tenant has
// responded… i want the app to start automatically reloading when small things like that
// happen. not necessarily for updates that i make but for updates that are important like
// those email responses."*
//
// That distinction is the whole design. An edit the landlord makes himself already repaints —
// every mutation calls its named set in invalidate.js. What does NOT repaint is a row a
// SOMEONE ELSE changed: `sign-envelope` is the only way a non-landlord party writes to this
// database (the one verify_jwt = false endpoint), and a tenant signing or declining moved
// nothing on screen until a hard reload.
//
// A NAMED option set rather than a literal at each call site, for the same reason
// invalidate.js exists: four hand-rolled `refetchInterval`s drift apart by omission, and the
// one left behind is the one nobody is looking at.
//
// ⚠ TWO NON-OBVIOUS CHOICES, both load-bearing:
//
//   refetchOnWindowFocus: 'always' — NOT `true`. `true` still respects staleTime, which is
//     five minutes globally (index.js), so reading the tenant's email and clicking straight
//     back to the tab would refetch NOTHING — precisely the flow this exists for. 'always'
//     ignores staleTime, and only for the queries that opt in: the global default stays
//     false, so every other page keeps its warm cache and prefetch.js keeps its staleTime-
//     based dedupe.
//
//   refetchIntervalInBackground is left at its default (false) — the timer PAUSES while the
//     window is blurred. So nothing polls while the landlord is away; it refetches once the
//     moment he comes back, then every 60s while he is actually looking at it. 60s is the
//     interval the dashboard feed has always run at, kept identical here so the strip and the
//     alert about the same envelope can never disagree by more than one tick.
export const LIVE_QUERY = {
  refetchInterval: 60_000,
  refetchOnWindowFocus: 'always',
};
