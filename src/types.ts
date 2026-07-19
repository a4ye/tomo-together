export type PublicUser = {
  username: string;
  name: string;
  color: string;
  species: string;
  equipped: string[];
};

export type Me = PublicUser & {
  birthday: string; // YYYY-MM-DD
  acorns: number;
  owned: string[];
};

export type TitleKind = 'stale' | 'streak' | 'best' | 'new' | 'close' | 'friend';

export type FriendView = PublicUser & {
  birthday: string; // MM-DD
  vibe: number;
  vibeLevel: number;
  vibeIntoLevel: number;
  vibePerLevel: number;
  lastHangoutAt: string | null; // ISO, last completed hangout together
  recentHangouts: number; // completed together in the last 30 days
  streak: boolean; // recentHangouts >= 3
  title: string; // short status, e.g. "Best friend" / "Need to hang out"
  titleKind: TitleKind;
};

export type FriendCard = PublicUser & {
  birthday: string; // MM-DD
  likes: string[]; // top activity labels from their learned weights
  dislikes: string[]; // bottom activity labels
  vibeLevel: number;
  lastHangoutAt: string | null;
};

export type Suggestion = {
  friend: PublicUser;
  activity: { id: string; label: string };
  date: string; // ISO
  reason: 'stale' | 'vibe';
};

export type FriendProfile = FriendView & {
  friendsSince: string; // ISO
  lastHangout: string | null; // ISO of most recent shared completed hangout
  hangoutCount: number;
  upcomingCount: number;
  topActivities: string[];
  recentMemories: Hangout[];
};

export type Activity = { id: string; label: string; combined?: number };

export type WardrobeItem = { id: string; name: string; price: number; type?: 'accessory' | 'mascot' };

export type Holiday = { month: number; day: number; label: string };

export type StakeMember = {
  username: string;
  staked: boolean;
  settleStatus: 'attended' | 'flaked' | 'refunded' | null;
  payoutUnits: string | null;
};

export type HangoutStake = {
  stakeUnits: string; // USDC base units (6 decimals)
  settled: boolean;
  poolUnits: string;
  members: StakeMember[];
  iStaked: boolean;
};

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
  stake: HangoutStake | null;
};

export type Wallet = {
  enabled: boolean;
  balanceUnits?: string;
  readyToCashOut?: boolean;
  cashoutThresholdUnits?: string;
  withdrawals?: { id: string; amountUnits: string; status: string }[];
};

export type Route =
  | { name: 'yard' }
  | { name: 'friends' }
  | { name: 'friendProfile'; username: string }
  | { name: 'hangouts' }
  | { name: 'newHangout'; preselect?: string }
  | { name: 'friendCard'; username: string }
  | { name: 'hangoutDetail'; hangoutId: number }
  | { name: 'photo'; hangoutId: number }
  | { name: 'confirm'; hangoutId: number; otherUsername: string; otherName: string }
  | { name: 'memoryBook' }
  | { name: 'leaderboard' }
  | { name: 'wardrobe' }
  | { name: 'deposit' }
  | { name: 'profile' };
