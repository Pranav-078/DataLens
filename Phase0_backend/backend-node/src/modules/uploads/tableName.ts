/**
 * Turns "Customer Orders (v2).CSV" into "customer_orders_v2" — a safe,
 * predictable table name. This is also the function used to DETECT
 * collisions: two filenames that normalize to the same string cannot both
 * become tables in the same version, so this function is called once per
 * file and the results are compared, not just used for display.
 */
export function normalizeTableName(originalFilename: string): string {
  const withoutExtension = originalFilename.replace(/\.[^./\\]+$/, "");

  return (
    withoutExtension
      .toLowerCase()
      // Anything that isn't a-z, 0-9 becomes an underscore.
      .replace(/[^a-z0-9]+/g, "_")
      // Collapse repeats and trim leading/trailing underscores.
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "") || "table"
  ); // fallback if the filename normalizes to nothing at all, e.g. "***.csv"
}
