import { Holiday } from './types';

// Mirrors the server's bonus rule so the app can preview it when planning.
export function bonusPreview(
  date: Date,
  holidays: Holiday[],
  attendees: { name: string; birthday: string }[] // birthday as MM-DD
): { mult: number; reason: string | null } {
  const hol = holidays.find((h) => h.month === date.getMonth() + 1 && h.day === date.getDate());
  if (hol) return { mult: 2, reason: hol.label };
  const mmdd = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const bd = attendees.find((a) => a.birthday === mmdd);
  if (bd) return { mult: 2, reason: `${bd.name}'s birthday` };
  return { mult: 1, reason: null };
}
