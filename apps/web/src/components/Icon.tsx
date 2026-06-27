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

/** Discord's brand mark. A filled glyph (ignores `strokeWidth`) that tints via
 *  `currentColor` so it sits naturally next to the lucide line-art. */
function DiscordGlyph({ size = 18, className, ...rest }: LucideProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
      className={className}
      {...rest}
    >
      <path d="M19.27 5.33A16.6 16.6 0 0 0 15.16 4l-.21.43a14.7 14.7 0 0 1 3.74 1.18 13.1 13.1 0 0 0-11.4 0 14.7 14.7 0 0 1 3.74-1.18L10.84 4a16.6 16.6 0 0 0-4.11 1.33A18.9 18.9 0 0 0 3 17.36 16.7 16.7 0 0 0 8.07 20l.62-.86a10.8 10.8 0 0 1-2.43-1.17l.47-.37a11.5 11.5 0 0 0 10.54 0l.47.37c-.76.45-1.57.84-2.43 1.17l.62.86A16.7 16.7 0 0 0 21 17.36a18.9 18.9 0 0 0-1.73-12.03ZM9.34 14.85c-.81 0-1.48-.74-1.48-1.66s.65-1.66 1.48-1.66 1.49.75 1.48 1.66c0 .92-.66 1.66-1.48 1.66Zm5.32 0c-.81 0-1.48-.74-1.48-1.66s.65-1.66 1.48-1.66 1.49.75 1.48 1.66c0 .92-.65 1.66-1.48 1.66Z" />
    </svg>
  );
}

/** GitHub's brand mark — a filled glyph (ignores `strokeWidth`) tinting via
 *  `currentColor`, matching DiscordGlyph's treatment. */
function GithubGlyph({ size = 18, className, ...rest }: LucideProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
      className={className}
      {...rest}
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49l-.01-1.72c-2.78.62-3.37-1.37-3.37-1.37-.46-1.18-1.11-1.5-1.11-1.5-.91-.63.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.89 1.57 2.34 1.11 2.91.85.09-.66.35-1.11.63-1.37-2.22-.26-4.55-1.14-4.55-5.06 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05a9.3 9.3 0 0 1 2.5-.34c.85 0 1.71.12 2.5.34 1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.93-2.34 4.79-4.57 5.05.36.32.68.94.68 1.9l-.01 2.82c0 .27.18.59.69.49A10.04 10.04 0 0 0 22 12.25C22 6.58 17.52 2 12 2Z"
      />
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

  // brands (filled glyph; ignores strokeWidth, tints via currentColor)
  discord: DiscordGlyph,
  github: GithubGlyph,
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
