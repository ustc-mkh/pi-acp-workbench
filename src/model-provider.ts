/** Pi catalogue IDs are provider/model. Keep unqualified ACP IDs in one group. */
export function modelProvider(id: string): string {
  const slash = id.indexOf('/');
  return slash > 0 ? id.slice(0, slash) : '当前供应商';
}
