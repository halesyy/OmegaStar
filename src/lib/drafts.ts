// Composer drafts per composer, so a suggested first message survives navigation.
const drafts = new Map<string, string>();
export const getDraft = (key: string) => drafts.get(key) ?? "";
export const setDraft = (key: string, text: string) => {
  if (text) drafts.set(key, text);
  else drafts.delete(key);
};
