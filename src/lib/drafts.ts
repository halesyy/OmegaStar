// Composer drafts per employee, so a suggested first message survives navigation.
const drafts = new Map<string, string>();
export const getDraft = (employeeId: string) => drafts.get(employeeId) ?? "";
export const setDraft = (employeeId: string, text: string) => {
  if (text) drafts.set(employeeId, text);
  else drafts.delete(employeeId);
};
