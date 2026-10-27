/** Match channel aliases while preserving version/date and model variant suffixes. */
export function modelDefaultKey(model: string) {
  return model
    .slice(model.lastIndexOf('/') + 1)
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}
