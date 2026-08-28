import type { GenerationPageRecord, SessionPageRecord } from '../db/records'

export function selectRetrySessionPages(args: {
  sessionPages: SessionPageRecord[]
  sourceRunPages?: GenerationPageRecord[]
}): { selected: SessionPageRecord[]; staleIds: string[] } {
  const sourcePageIds = new Set(
    (args.sourceRunPages || []).map((page) => page.page_id).filter(Boolean)
  )
  const latestByPageNumber = new Map<number, SessionPageRecord>()
  for (const page of args.sessionPages) {
    const previous = latestByPageNumber.get(page.page_number)
    if (!previous) {
      latestByPageNumber.set(page.page_number, page)
      continue
    }

    const pageBelongsToSourceRun = sourcePageIds.has(page.file_slug)
    const previousBelongsToSourceRun = sourcePageIds.has(previous.file_slug)
    const shouldReplace =
      (pageBelongsToSourceRun && !previousBelongsToSourceRun) ||
      (pageBelongsToSourceRun === previousBelongsToSourceRun &&
        (page.updated_at > previous.updated_at ||
          (page.updated_at === previous.updated_at && page.created_at >= previous.created_at)))
    if (shouldReplace) latestByPageNumber.set(page.page_number, page)
  }

  // A retry run contains only failed pages. It must never redefine the deck as
  // that subset; keep one canonical record for every page number in the session.
  const selected = Array.from(latestByPageNumber.values())

  const selectedIds = new Set(selected.map((page) => page.id))
  return {
    selected: selected.sort((a, b) => a.page_number - b.page_number),
    staleIds: args.sessionPages
      .filter((page) => !selectedIds.has(page.id))
      .map((page) => page.id)
  }
}
