// Constant tables, transcribed verbatim from server/index.js. `GET /catalog`
// serialises ACTIVITIES/ITEMS/HOLIDAYS in this exact order and the contract
// suite pins the sha256 of that payload, so nothing here may be reordered.

export const SPECIES = ['cat', 'bear', 'bunny', 'frog', 'duck'];

export const ACTIVITY_GROUPS: Array<[string, Array<[string, string]>]> = [
  ['Food & Drink', [
    ['ramen', 'Ramen'], ['sushi', 'Sushi'], ['tacos', 'Tacos'], ['bbq', 'BBQ'],
    ['brunch', 'Brunch'], ['coffee', 'Coffee'], ['boba', 'Bubble Tea'],
    ['dessert', 'Dessert Run'], ['cooking', 'Cooking Together'], ['baking', 'Baking'],
    ['winenight', 'Wine Night'], ['brewery', 'Brewery'],
  ]],
  ['Outdoors', [
    ['hiking', 'Hiking'], ['picnic', 'Picnic'], ['beach', 'Beach Day'],
    ['camping', 'Camping'], ['fishing', 'Fishing'], ['kayaking', 'Kayaking'],
    ['stargazing', 'Stargazing'], ['gardening', 'Gardening'], ['roadtrip', 'Road Trip'],
  ]],
  ['Active & Sports', [
    ['gym', 'Gym'], ['yoga', 'Yoga'], ['running', 'Running'], ['cycling', 'Cycling'],
    ['climbing', 'Climbing'], ['basketball', 'Basketball'], ['soccer', 'Soccer'],
    ['tennis', 'Tennis'], ['volleyball', 'Volleyball'], ['swimming', 'Swimming'],
    ['skiing', 'Skiing'], ['surfing', 'Surfing'], ['skating', 'Skating'], ['bowling', 'Bowling'],
  ]],
  ['Games & Play', [
    ['boardgames', 'Board Games'], ['videogames', 'Video Games'], ['arcade', 'Arcade'],
    ['escaperoom', 'Escape Room'], ['lasertag', 'Laser Tag'], ['minigolf', 'Mini Golf'],
    ['trivia', 'Trivia Night'], ['chess', 'Chess'], ['ttrpg', 'D&D Night'], ['karting', 'Go Karting'],
  ]],
  ['Arts & Culture', [
    ['museum', 'Museum'], ['artgallery', 'Art Gallery'], ['theater', 'Theater'],
    ['pottery', 'Pottery'], ['painting', 'Painting'], ['photography', 'Photography'],
    ['bookcafe', 'Book Cafe'], ['bookclub', 'Book Club'],
  ]],
  ['Music & Nightlife', [
    ['karaoke', 'Karaoke'], ['concert', 'Concert'], ['livemusic', 'Live Music'],
    ['dancing', 'Dancing'], ['barhopping', 'Bar Hopping'], ['comedy', 'Comedy Show'],
  ]],
  ['Chill & Social', [
    ['film', 'Movie Night'], ['anime', 'Anime Night'], ['shopping', 'Shopping'],
    ['thrifting', 'Thrifting'], ['spa', 'Spa Day'], ['cafe', 'Cafe Hangout'],
    ['volunteering', 'Volunteering'], ['petpark', 'Dog Park'],
    ['amusementpark', 'Amusement Park'], ['aquarium', 'Aquarium'],
  ]],
];

export interface Activity {
  id: string;
  label: string;
  category: string;
}

export const ACTIVITIES: Activity[] = ACTIVITY_GROUPS.flatMap(([category, items]) =>
  items.map(([id, label]) => ({ id, label, category })));

export const ACTIVITY_IDS = new Set(ACTIVITIES.map((a) => a.id));
export const labelOf = (id: string): string | undefined =>
  ACTIVITIES.find((a) => a.id === id)?.label;

export const ITEMS = [
  { id: 'party_hat', name: 'Party Hat', price: 60 },
  { id: 'beanie', name: 'Beanie', price: 50 },
  { id: 'flower_crown', name: 'Flower Crown', price: 80 },
  { id: 'crown', name: 'Crown', price: 150 },
  { id: 'round_glasses', name: 'Round Glasses', price: 40 },
  { id: 'star_glasses', name: 'Star Glasses', price: 70 },
  { id: 'sunglasses', name: 'Sunglasses', price: 55 },
  { id: 'scarf', name: 'Scarf', price: 45 },
  { id: 'bowtie', name: 'Bow Tie', price: 40 },
  { id: 'wizard_hat', name: 'Wizard Hat', price: 120 },
  { id: 'cowboy_hat', name: 'Cowboy Hat', price: 90 },
  { id: 'chef_hat', name: "Chef's Puff", price: 75 },
  { id: 'halo', name: 'Halo', price: 160 },
  { id: 'cat_ears', name: 'Cat Ears', price: 65 },
  { id: 'propeller_cap', name: 'Propeller Cap', price: 85 },
  { id: 'viking_helm', name: 'Viking Helm', price: 150 },
  { id: 'monocle', name: 'Fancy Monocle', price: 95 },
  { id: 'eyepatch', name: 'Pirate Patch', price: 60 },
  { id: 'heart_glasses', name: 'Heart Shades', price: 70 },
  { id: 'ski_goggles', name: 'Ski Goggles', price: 80 },
  { id: 'bandana', name: 'Bandana', price: 40 },
  { id: 'bell_collar', name: 'Jingle Collar', price: 55 },
  { id: 'bow_ribbon', name: 'Big Bow', price: 65 },
];

export const HOLIDAYS = [
  { month: 1, day: 1, label: 'New Year' },
  { month: 2, day: 14, label: 'Valentines' },
  { month: 7, day: 30, label: 'Friendship Day' },
  { month: 10, day: 31, label: 'Halloween' },
  { month: 12, day: 25, label: 'Christmas' },
  { month: 12, day: 31, label: 'New Years Eve' },
];

export const INTEREST_BOOST = 15;
export const VIBE_PER_CONFIRM = 15;
export const VIBE_PER_LEVEL = 60;
export const ACORNS_PER_LEVEL = 30;

export const WORLD_W = 2400;
export const WORLD_H = 1800;
export const AVATAR_R = 40;
