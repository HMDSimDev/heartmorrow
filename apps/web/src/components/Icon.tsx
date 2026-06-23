import {
  Home,
  Users,
  Heart,
  HeartHandshake,
  HandHeart,
  HeartCrack,
  Smartphone,
  Gamepad2,
  Backpack,
  Store,
  Settings,
  Pencil,
  Bug,
  BookOpen,
  Gem,
  Flag,
  DoorOpen,
  MapPin,
  Undo2,
  Plus,
  Trash2,
  Copy,
  Save,
  Download,
  Upload,
  Check,
  X,
  ChevronDown,
  ChevronRight,
  Sparkles,
  RefreshCw,
  MessageCircle,
  Mail,
  Share2,
  Images,
  Award,
  Trophy,
  CloudSun,
  CalendarDays,
  Briefcase,
  Coins,
  Music,
  Star,
  Send,
  Gift,
  Flame,
  Search,
  Swords,
  Footprints,
  Eye,
  Info,
  CircleAlert,
  Play,
  Wine,
  Shirt,
  ThumbsUp,
  Laugh,
  Frown,
  Angry,
  PartyPopper,
  Moon,
  Globe,
  Building2,
  TrendingUp,
  Landmark,
  Dice5,
  type LucideProps,
} from 'lucide-react';

/** A bespoke constellation glyph — lamplit stars threaded by light. On-theme for the
 *  relationship map; tints via `currentColor` like the lucide line-art around it. */
function Constellation({ size = 18, strokeWidth = 1.75, className, ...rest }: LucideProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...rest}
    >
      <path d="M5 8l6 5 6.5-6M11 13l3 6" opacity={0.55} />
      <circle cx="5" cy="8" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="11" cy="13" r="2" fill="currentColor" stroke="none" />
      <circle cx="17.5" cy="7" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="14" cy="19" r="1.25" fill="currentColor" stroke="none" />
    </svg>
  );
}

/* One semantic icon vocabulary for the whole app. Call sites say what a glyph
   MEANS (<Icon name="date" />), so the lamplit line-art can be retuned in one
   place. Icons inherit `currentColor`, so they tint with the Nocturne tokens
   wherever they're placed. Diegetic emoji (weather, character/chat content)
   stay as emoji — this map is only for UI chrome. */
const ICONS = {
  // shell / nav
  home: Home,
  people: Users,
  date: Heart,
  phone: Smartphone,
  games: Gamepad2,
  bag: Backpack,
  shop: Store,
  settings: Settings,
  edit: Pencil,
  debug: Bug,
  chronicle: BookOpen,
  worlds: Globe,

  // item categories
  gift: Gift,
  consumable: Wine,
  apparel: Shirt,
  book: BookOpen,
  special: Sparkles,

  // romance beats
  commit: HeartHandshake,
  ring: Gem,
  breakup: HeartCrack,
  remember: Flame,

  // social-web relationship kinds (monochrome, tint via currentColor / --kc)
  rival: Swords,
  acquaintance: Footprints,

  // actions
  end: Flag,
  leave: DoorOpen,
  location: MapPin,
  recap: Undo2,
  plus: Plus,
  trash: Trash2,
  duplicate: Copy,
  save: Save,
  download: Download,
  upload: Upload,
  check: Check,
  close: X,
  chevronDown: ChevronDown,
  chevronRight: ChevronRight,
  generate: Sparkles,
  refresh: RefreshCw,
  search: Search,
  preview: Eye,
  info: Info,
  warn: CircleAlert,
  play: Play,
  send: Send,
  image: Images,

  // phone apps
  messages: MessageCircle,
  mail: Mail,
  social: Share2,
  constellation: Constellation,
  faces: Users,
  moments: Images,
  endings: Award,
  weather: CloudSun,
  calendar: CalendarDays,
  work: Briefcase,
  together: HandHeart,

  // economy / rewards
  coin: Coins,
  property: Building2,
  stocks: TrendingUp,
  wealth: Landmark,
  gambling: Dice5,
  affection: Heart,
  star: Star,
  trophy: Trophy,
  music: Music,
  sparkle: Sparkles,
  moon: Moon,
  celebrate: PartyPopper,

  // faces reactions
  reactLike: ThumbsUp,
  reactLove: Heart,
  reactLaugh: Laugh,
  reactWow: PartyPopper,
  reactSad: Frown,
  reactAngry: Angry,
} satisfies Record<string, React.ComponentType<LucideProps>>;

export type IconName = keyof typeof ICONS;

export function Icon({
  name,
  size = 18,
  strokeWidth = 1.75,
  className,
  ...rest
}: { name: IconName } & LucideProps) {
  const Cmp = ICONS[name];
  return <Cmp size={size} strokeWidth={strokeWidth} className={className} aria-hidden {...rest} />;
}
