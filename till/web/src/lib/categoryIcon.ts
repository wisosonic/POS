import type { IconName } from '../components/Icon';

// A category tile gets a picture chosen from the words in its name (English or Arabic). Anything not recognised gets the
// plain product box, so a new category always has an icon without anyone choosing one.
const RULES: { icon: IconName; words: RegExp }[] = [
  { icon: 'drink', words: /drink|beverage|juice|water|soda|cola|coffee|tea\b|مشروب|عصير|ماء|مياه|قهوة|شاي/i },
  { icon: 'dairy', words: /dairy|milk|cheese|yogh?urt|labn|butter|ألبان|حليب|جبن|لبن|زبدة/i },
  { icon: 'snack', words: /snack|chip|biscuit|cookie|chocolate|candy|sweet|cake|wafer|تسالي|بسكويت|شوكولا|حلويات|سكاكر/i },
  { icon: 'drop', words: /hygiene|clean|soap|detergent|shampoo|care|beauty|nettoy|منظف|نظافة|صابون|عناية/i },
  { icon: 'home', words: /house|home|kitchen|towel|paper|plastic|stationery|منزل|مطبخ|أدوات|ورق/i },
  { icon: 'basket', words: /grocer|food|rice|oil|flour|canned|bakery|bread|fruit|vegetable|meat|مواد غذائية|بقالة|خضار|فواكه|لحم|خبز/i },
];

/** The icon for a category tile. The group with no category gets a folder. */
export function categoryIcon(name: string, hasCategory = true): IconName {
  if (!hasCategory) return 'folder';
  return RULES.find((r) => r.words.test(name))?.icon ?? 'products';
}
