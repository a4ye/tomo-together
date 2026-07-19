export type PublicUser = {
  username: string;
  name: string;
  color: string;
  equipped: string[];
};

export type Me = PublicUser & {
  birthday: string; // YYYY-MM-DD
  acorns: number;
  owned: string[];
};

export type FriendView = PublicUser & {
  birthday: string; // MM-DD
  vibe: number;
  vibeLevel: number;
  vibeIntoLevel: number;
  vibePerLevel: number;
};

export type Activity = { id: string; label: string; combined?: number };

export type WardrobeItem = { id: string; name: string; price: number };

export type Holiday = { month: number; day: number; label: string };

export type Hangout = {
  id: number;
  activity: string;
  activityLabel: string;
  date: string;
  place: string;
  bonusMult: number;
  bonusReason: string | null;
  photoUrl: string | null;
  completedAt: string | null;
  members: PublicUser[];
  confirmedPairs: [string, string][];
  pairsTotal: number;
};

export type Route =
  | { name: 'yard' }
  | { name: 'friends' }
  | { name: 'hangouts' }
  | { name: 'newHangout' }
  | { name: 'hangoutDetail'; hangoutId: number }
  | { name: 'photo'; hangoutId: number }
  | { name: 'confirm'; hangoutId: number; otherUsername: string; otherName: string }
  | { name: 'memoryBook' }
  | { name: 'leaderboard' }
  | { name: 'wardrobe' }
  | { name: 'deposit' }
  | { name: 'profile' };
