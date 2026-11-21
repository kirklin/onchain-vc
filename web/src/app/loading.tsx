import { Skeleton } from "~/components/states";

/** Shown while a page's server part is still on its way. */
export default function Loading() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="mt-4 mb-4 h-10 w-48" />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Skeleton className="h-64" />
        <Skeleton className="h-64" />
      </div>
    </div>
  );
}
