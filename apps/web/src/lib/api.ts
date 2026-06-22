import type {
  ActivityDef,
  Asset,
  Character,
  CharacterChronicle,
  CharacterEnding,
  CharacterBundle,
  CharacterCreate,
  CharacterMemory,
  CharacterUpdate,
  DatingStats,
  Email,
  Intent,
  CreateFeedPostResponse,
  FeedPostView,
  FeedView,
  GenerateDatingStatsInput,
  GenerateLocationsInput,
  GenerateWorldInput,
  WorldGenDraft,
  GenerateProfileInput,
  GenerateCharacterFromImageInput,
  GenerateCharacterFromSourcesInput,
  GenerateShopItemsInput,
  CharacterTemplateDraft,
  ProfileGeneration,
  ReactionKind,
  SocialWeb,
  Location,
  PerformActivity,
  PhoneInbox,
  PhoneThreadSummary,
  StructuredResult,
  TextMessage,
  TogetherResult,
  ActiveDate,
  ConversationCreate,
  ConversationSession,
  DtrResponse,
  GiftReactionResponse,
  EndSessionResponse,
  PlayerBreakupResponse,
  GameEvent,
  InventoryItem,
  ItemEffect,
  LlmHealthResult,
  LlmModelInfo,
  LlmSettings,
  LlmSettingsUpdate,
  PromptEstimateRequest,
  PromptEstimateResult,
  BenchCatalog,
  BenchBaseline,
  BenchBaselineValue,
  BenchCaseResult,
  BenchRunSummary,
  BenchRunListItem,
  BenchRunCaseRequest,
  BenchRunRequest,
  BenchSettingsSnapshot,
  MemoryCreate,
  Message,
  Moment,
  PackInspectResult,
  PackImportResult,
  MinigameFinish,
  MinigameFinishResponse,
  MinigameInfo,
  MinigameResult,
  MinigameStart,
  MinigameStartResponse,
  PlayerProfile,
  PlayerUpdate,
  Relationship,
  SessionWithMessages,
  ShopItem,
  ShopItemCreate,
  ShopItemUpdate,
  Property,
  PropertyView,
  PropertyCreate,
  PropertyUpdate,
  GeneratePropertiesInput,
  BuyPropertyResponse,
  SellPropertyResponse,
  LeaseResponse,
  LandlordInbox,
  Company,
  CompanyCreate,
  CompanyUpdate,
  GenerateCompaniesInput,
  MarketView,
  PortfolioView,
  TradeStockResponse,
  WealthSummary,
  GamblingStateView,
  SlotsResult,
  RouletteResult,
  RouletteBet,
  BlackjackResponse,
  VideoPokerResponse,
  SleepResponse,
  World,
  WorldCalendar,
  WorldState,
  WorldWeather,
  WorldCreate,
  WorldNote,
  WorldNoteCreate,
  WorldNoteUpdate,
  WorldUpdate,
} from '@dsim/shared';

const BASE = '/api';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(options.headers as Record<string, string> | undefined) };
  // Only declare a JSON content-type when we actually send a JSON body. A POST
  // with `Content-Type: application/json` but no body is rejected by Fastify
  // ("Body cannot be empty when content-type is set to 'application/json'").
  if (options.body != null && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${BASE}${path}`, { ...options, headers });
  if (!res.ok) {
    let message = res.statusText;
    let details: unknown;
    try {
      const body = await res.json();
      message = body.error ?? message;
      details = body.details;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(message, res.status, details);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const get = <T>(path: string) => request<T>(path);
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const patch = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
const del = <T>(path: string) => request<T>(path, { method: 'DELETE' });

/** `?worldId=…` query suffix, or '' when no world is given. */
const worldQuery = (worldId?: string): string => (worldId ? `?worldId=${encodeURIComponent(worldId)}` : '');

/** Build a browser URL for an uploaded asset path. */
export function assetUrl(relativePath: string): string {
  return `/uploads/${relativePath.replace(/^\/+/, '')}`;
}

/**
 * Fetch a binary share file and save it via a temporary download link. Prefers the
 * server's Content-Disposition filename, falling back to a supplied name.
 */
async function downloadShareFile(path: string, init: RequestInit, fallbackName: string): Promise<void> {
  const res = await fetch(`${BASE}${path}`, init);
  if (!res.ok) {
    let message = res.statusText;
    try {
      message = (await res.json()).error ?? message;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(message, res.status);
  }
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') ?? '';
  const match = /filename="?([^"]+)"?/.exec(cd);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = match?.[1] ?? fallbackName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** POST a single uploaded share file (multipart) and read the JSON response. */
async function postShareFile<T>(path: string, file: File): Promise<T> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${BASE}${path}`, { method: 'POST', body: form });
  if (!res.ok) {
    let message = res.statusText;
    let details: unknown;
    try {
      const body = await res.json();
      message = body.error ?? message;
      details = body.details;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(message, res.status, details);
  }
  return res.json() as Promise<T>;
}

export interface StreamHandlers {
  onPlayer?: (message: Message) => void;
  onDelta?: (text: string) => void;
  onDone?: (message: Message) => void;
  onError?: (message: string) => void;
  /** Non-fatal notice (e.g. the reply was truncated at the token limit). */
  onNotice?: (message: string) => void;
  /** The character ended the date and walked out. */
  onWalkout?: (message: Message, reason: string) => void;
  /** The player's message read as a breakup; the character reacted (awaiting confirm). */
  onBreakupIntent?: (message: Message, reaction: 'accept' | 'hurt' | 'plead') => void;
  /** Per-turn rapport read, emitted BEFORE the reply: a vibe label, the live
   *  expression, the numeric trajectory (0..100, internal), and the signed change
   *  this turn — drives the date trajectory bar. */
  onRapport?: (vibe: string, expression: string, rapport: number, delta: number) => void;
  /** The character lost interest and ended the date early (a soft exit). */
  onLeft?: (message: Message, reason: string) => void;
  /** The player wound the date down to a natural close; the character said
   *  goodbye. The client should run the normal end-and-evaluate flow. */
  onFarewell?: (message: Message, expression?: string) => void;
}

/** Stream a chat reply via SSE (POST + ReadableStream reader). */
export async function streamChat(
  sessionId: string,
  text: string,
  handlers: StreamHandlers,
  signal?: AbortSignal,
  intent?: Intent,
): Promise<void> {
  const res = await fetch(`${BASE}/conversations/${sessionId}/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(intent ? { text, intent } : { text }),
    signal,
  });
  if (!res.ok || !res.body) {
    handlers.onError?.(`Server returned ${res.status}`);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const dispatch = (block: string) => {
    let event = 'message';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!data) return;
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    switch (event) {
      case 'player':
        handlers.onPlayer?.(payload as Message);
        break;
      case 'delta':
        handlers.onDelta?.((payload as { text: string }).text);
        break;
      case 'done':
        handlers.onDone?.((payload as { message: Message }).message);
        break;
      case 'error':
        handlers.onError?.((payload as { message: string }).message);
        break;
      case 'notice':
        handlers.onNotice?.((payload as { message: string }).message);
        break;
      case 'walkout': {
        const p = payload as { message: Message; reason: string };
        handlers.onWalkout?.(p.message, p.reason);
        break;
      }
      case 'breakup_intent': {
        const p = payload as { message: Message; reaction: 'accept' | 'hurt' | 'plead' };
        handlers.onBreakupIntent?.(p.message, p.reaction);
        break;
      }
      case 'rapport': {
        const p = payload as { label: string; expression: string; rapport: number; delta: number };
        handlers.onRapport?.(p.label, p.expression, p.rapport, p.delta);
        break;
      }
      case 'left': {
        const p = payload as { message: Message; reason: string };
        handlers.onLeft?.(p.message, p.reason);
        break;
      }
      case 'farewell': {
        const p = payload as { message: Message; expression?: string };
        handlers.onFarewell?.(p.message, p.expression);
        break;
      }
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      dispatch(block);
    }
  }
}

export interface SettingsResponse extends LlmSettings {
  apiKeySet: boolean;
}

export const api = {
  health: () => get<{ ok: boolean }>('/health'),

  // settings
  getSettings: () => get<SettingsResponse>('/settings'),
  updateSettings: (update: LlmSettingsUpdate) => patch<SettingsResponse>('/settings', update),
  testLlm: (override?: LlmSettingsUpdate) => post<LlmHealthResult>('/settings/test', override ?? {}),
  listModels: (override?: LlmSettingsUpdate) =>
    post<{ ok: boolean; models: LlmModelInfo[]; error?: string }>('/settings/models', override ?? {}),
  estimatePrompts: (input: Partial<PromptEstimateRequest>) =>
    post<PromptEstimateResult>('/settings/prompt-estimate', input),

  // Heartmorrow Bench — model evaluation harness
  benchCatalog: () => get<BenchCatalog>('/bench/catalog'),
  benchBaselines: () => get<{ baselines: BenchBaseline[] }>('/bench/baselines'),
  benchSaveBaseline: (caseId: string, value: BenchBaselineValue, note = '') =>
    request<BenchBaseline>(`/bench/baselines/${encodeURIComponent(caseId)}`, {
      method: 'PUT',
      body: JSON.stringify({ value, note }),
    }),
  benchClearBaseline: (caseId: string) => del<{ ok: boolean }>(`/bench/baselines/${encodeURIComponent(caseId)}`),
  /** Run ONE case. Accepts an AbortSignal so a long run can be cancelled. */
  benchRunCase: (body: BenchRunCaseRequest, signal?: AbortSignal) =>
    request<BenchCaseResult>('/bench/run-case', { method: 'POST', body: JSON.stringify(body), signal }),
  /** Abort the in-flight case for a run id (server-side, proxy-independent). */
  benchCancel: (runId: string) => post<{ ok: boolean; cancelled: boolean }>('/bench/cancel', { runId }),
  benchSaveRun: (label: string, runReq: BenchRunRequest, results: BenchCaseResult[], settings?: BenchSettingsSnapshot | null) =>
    post<BenchRunSummary>('/bench/runs', { label, request: runReq, results, settings: settings ?? null }),
  benchRuns: () => get<{ runs: BenchRunListItem[] }>('/bench/runs'),
  benchRun: (id: string) => get<BenchRunSummary>(`/bench/runs/${encodeURIComponent(id)}`),
  benchDeleteRun: (id: string) => del<{ ok: boolean }>(`/bench/runs/${encodeURIComponent(id)}`),

  // player (per-world: money + persona live under the active world)
  getPlayer: (worldId?: string) => get<PlayerProfile>(`/player${worldQuery(worldId)}`),
  updatePlayer: (update: PlayerUpdate, worldId?: string) =>
    patch<PlayerProfile>(`/player${worldQuery(worldId)}`, update),

  // worlds
  listWorlds: () => get<World[]>('/worlds'),
  getWorld: (id: string) => get<World>(`/worlds/${id}`),
  createWorld: (input: WorldCreate) => post<World>('/worlds', input),
  cloneWorld: (sourceWorldId: string, name: string) => post<World>(`/worlds/${sourceWorldId}/clone`, { name }),
  importCharacters: (worldId: string, sourceCharacterIds: string[]) =>
    post<Character[]>(`/worlds/${worldId}/import-characters`, { sourceCharacterIds }),
  updateWorld: (id: string, patchInput: WorldUpdate) => patch<World>(`/worlds/${id}`, patchInput),
  deleteWorld: (id: string, deleteCharacters = false) =>
    del<{ ok: true }>(`/worlds/${id}${deleteCharacters ? '?deleteCharacters=true' : ''}`),
  generateLocations: (worldId: string, input: GenerateLocationsInput) =>
    post<StructuredResult<Location[]>>(`/worlds/${worldId}/locations/generate`, input),
  generateWorld: (input: GenerateWorldInput) =>
    post<StructuredResult<WorldGenDraft>>(`/worlds/generate`, input),
  listWorldNotes: (worldId: string) => get<WorldNote[]>(`/worlds/${worldId}/notes`),
  createWorldNote: (worldId: string, input: WorldNoteCreate) =>
    post<WorldNote>(`/worlds/${worldId}/notes`, input),
  updateWorldNote: (noteId: string, patchInput: WorldNoteUpdate) =>
    patch<WorldNote>(`/world-notes/${noteId}`, patchInput),
  deleteWorldNote: (noteId: string) => del<{ ok: true }>(`/world-notes/${noteId}`),
  getWorldState: (worldId: string) => get<WorldState>(`/worlds/${worldId}/state`),
  sleep: (worldId: string) => post<SleepResponse>(`/worlds/${worldId}/sleep`),
  worldAvailability: (worldId: string) =>
    get<Array<{ characterId: string; available: boolean; reason: string | null }>>(`/worlds/${worldId}/availability`),
  /** The world's single in-progress date (for auto-resume + locking actions), or null. */
  activeDate: (worldId: string) => get<{ date: ActiveDate | null }>(`/worlds/${worldId}/active-date`),
  worldWeather: (worldId: string) => get<WorldWeather>(`/worlds/${worldId}/weather`),
  worldCalendar: (worldId: string) => get<WorldCalendar>(`/worlds/${worldId}/calendar`),

  // characters (optional worldId scopes the roster to the active save)
  listCharacters: (worldId?: string) => get<Character[]>(`/characters${worldQuery(worldId)}`),
  socialWeb: (worldId?: string) => get<SocialWeb>(`/social-web${worldQuery(worldId)}`),
  getCharacter: (id: string) => get<Character>(`/characters/${id}`),
  getCharacterBundle: (id: string) => get<CharacterBundle>(`/characters/${id}/bundle`),
  createCharacter: (input: CharacterCreate) => post<Character>('/characters', input),
  generateStats: (input: GenerateDatingStatsInput) =>
    post<StructuredResult<DatingStats>>('/characters/generate-stats', input),
  generateProfile: (input: GenerateProfileInput) =>
    post<StructuredResult<ProfileGeneration>>('/characters/generate-profile', input),
  generateCharacterFromImage: (input: GenerateCharacterFromImageInput) =>
    post<StructuredResult<CharacterTemplateDraft>>('/characters/generate-from-image', input),
  /** Unified generator: from a portrait, pasted/uploaded text, or both. */
  generateCharacter: (input: GenerateCharacterFromSourcesInput) =>
    post<StructuredResult<CharacterTemplateDraft>>('/characters/generate', input),
  updateCharacter: (id: string, patchInput: CharacterUpdate) =>
    patch<Character>(`/characters/${id}`, patchInput),
  deleteCharacter: (id: string) => del<{ ok: true }>(`/characters/${id}`),
  duplicateCharacter: (id: string) => post<Character>(`/characters/${id}/duplicate`),
  getRelationship: (id: string) => get<Relationship>(`/characters/${id}/relationship`),
  listMemories: (id: string) => get<CharacterMemory[]>(`/characters/${id}/memories`),
  addMemory: (id: string, input: MemoryCreate) => post<CharacterMemory>(`/characters/${id}/memories`, input),
  deleteMemory: (memoryId: string) => del<{ ok: true }>(`/memories/${memoryId}`),
  promptPreview: (id: string) => get<{ system: string; approxChars: number }>(`/characters/${id}/prompt-preview`),
  getChronicle: (id: string) => get<CharacterChronicle>(`/characters/${id}/chronicle`),
  getMoments: (id: string) => get<Moment[]>(`/characters/${id}/moments`),
  getRoom: (id: string) => get<{ name: string; description: string }>(`/characters/${id}/room`),

  // assets
  listAssets: () => get<Asset[]>('/assets'),
  uploadAsset: async (file: File, type: Asset['type'], altText: string, tags: string): Promise<Asset> => {
    const form = new FormData();
    form.append('type', type);
    if (altText) form.append('altText', altText);
    if (tags) form.append('tags', tags);
    form.append('file', file);
    const res = await fetch(`${BASE}/assets`, { method: 'POST', body: form });
    if (!res.ok) {
      let message = res.statusText;
      try {
        message = (await res.json()).error ?? message;
      } catch {
        /* ignore */
      }
      throw new ApiError(message, res.status);
    }
    return res.json();
  },
  deleteAsset: (id: string) => del<{ ok: true }>(`/assets/${id}`),

  // conversations
  listConversations: () => get<ConversationSession[]>('/conversations'),
  createConversation: (input: ConversationCreate) => post<ConversationSession>('/conversations', input),
  getConversation: (id: string) => get<SessionWithMessages>(`/conversations/${id}`),
  sendMessage: (id: string, text: string) =>
    post<{ playerMessage: Message; reply: Message }>(`/conversations/${id}/messages`, { text }),
  summarize: (id: string) => post<ConversationSession>(`/conversations/${id}/summarize`),
  endSession: (id: string) => post<EndSessionResponse>(`/conversations/${id}/end`),
  defineRelationship: (id: string) => post<DtrResponse>(`/conversations/${id}/dtr`),
  giftOnDate: (id: string, inventoryItemId: string) =>
    post<GiftReactionResponse>(`/conversations/${id}/gift`, { inventoryItemId }),
  confirmBreakup: (id: string) => post<PlayerBreakupResponse>(`/conversations/${id}/breakup`),

  // shop + inventory
  listShopItems: () => get<ShopItem[]>('/shop/items'),
  createShopItem: (input: ShopItemCreate) => post<ShopItem>('/shop/items', input),
  generateShopItems: (input: GenerateShopItemsInput) =>
    post<StructuredResult<ShopItemCreate[]>>('/shop/items/generate', input),
  updateShopItem: (id: string, patchInput: ShopItemUpdate) => patch<ShopItem>(`/shop/items/${id}`, patchInput),
  deleteShopItem: (id: string) => del<{ ok: true }>(`/shop/items/${id}`),
  purchase: (shopItemId: string, quantity = 1, worldId?: string) =>
    post<{ player: PlayerProfile; item: ShopItem; inventoryItem: InventoryItem }>('/shop/purchase', {
      shopItemId,
      quantity,
      worldId: worldId ?? null,
    }),
  getInventory: (worldId?: string) =>
    get<{ entries: Array<{ inventoryItem: InventoryItem; item: ShopItem | null }>; player: PlayerProfile }>(
      `/inventory${worldQuery(worldId)}`,
    ),
  useItem: (inventoryItemId: string, characterId: string | null, worldId?: string) =>
    post<{
      player: PlayerProfile;
      relationship: Relationship | null;
      character: Character | null;
      inventoryItem: InventoryItem;
      item: ShopItem;
      appliedEffects: ItemEffect[];
    }>('/inventory/use', { inventoryItemId, characterId, worldId: worldId ?? null }),

  // property (per-world; gated by world.featureFlags.property)
  listProperties: (worldId: string) => get<{ properties: PropertyView[] }>(`/properties${worldQuery(worldId)}`),
  createProperty: (input: PropertyCreate) => post<Property>('/properties', input),
  generateProperties: (worldId: string, input: GeneratePropertiesInput) =>
    post<StructuredResult<PropertyCreate[]>>(`/properties/generate${worldQuery(worldId)}`, input),
  updateProperty: (id: string, patchInput: PropertyUpdate) => patch<Property>(`/properties/${id}`, patchInput),
  deleteProperty: (id: string) => del<{ ok: true }>(`/properties/${id}`),
  buyProperty: (worldId: string, propertyId: string) =>
    post<BuyPropertyResponse>('/properties/buy', { worldId, propertyId }),
  sellProperty: (worldId: string, propertyId: string) =>
    post<SellPropertyResponse>('/properties/sell', { worldId, propertyId }),
  leaseProperty: (worldId: string, propertyId: string) =>
    post<LeaseResponse>('/properties/lease', { worldId, propertyId }),
  payRent: (worldId: string, propertyId: string) =>
    post<LeaseResponse>('/properties/pay-rent', { worldId, propertyId }),
  endLease: (worldId: string, propertyId: string) =>
    post<{ money: number }>('/properties/end-lease', { worldId, propertyId }),
  landlordNotices: (worldId: string) => get<LandlordInbox>(`/properties/notices${worldQuery(worldId)}`),
  markLandlordRead: (worldId: string) => post<{ ok: true }>('/properties/notices/read', { worldId }),

  // stock market (per-world; gated by world.featureFlags.stockMarket)
  getMarket: (worldId: string) => get<MarketView>(`/market${worldQuery(worldId)}`),
  getPortfolio: (worldId: string) => get<PortfolioView>(`/portfolio${worldQuery(worldId)}`),
  listCompanies: (worldId: string) => get<{ companies: Company[] }>(`/market/companies${worldQuery(worldId)}`),
  createCompany: (input: CompanyCreate) => post<Company>('/market/companies', input),
  generateCompanies: (worldId: string, input: GenerateCompaniesInput) =>
    post<StructuredResult<CompanyCreate[]>>(`/market/companies/generate${worldQuery(worldId)}`, input),
  updateCompany: (id: string, patchInput: CompanyUpdate) => patch<Company>(`/market/companies/${id}`, patchInput),
  deleteCompany: (id: string) => del<{ ok: true }>(`/market/companies/${id}`),
  buyStock: (worldId: string, companyId: string, shares: number) =>
    post<TradeStockResponse>('/market/buy', { worldId, companyId, shares }),
  sellStock: (worldId: string, companyId: string, shares: number) =>
    post<TradeStockResponse>('/market/sell', { worldId, companyId, shares }),
  getWealth: (worldId: string) => get<WealthSummary>(`/wealth${worldQuery(worldId)}`),

  // casino (per-world; gated by world.featureFlags.gambling)
  gamblingState: (worldId: string) => get<GamblingStateView>(`/gambling${worldQuery(worldId)}`),
  playSlots: (worldId: string, bet: number) => post<SlotsResult>('/gambling/slots', { worldId, bet }),
  playRoulette: (worldId: string, bets: RouletteBet[]) => post<RouletteResult>('/gambling/roulette', { worldId, bets }),
  startBlackjack: (worldId: string, bet: number) => post<BlackjackResponse>('/gambling/blackjack/start', { worldId, bet }),
  blackjackAction: (worldId: string, roundId: string, action: 'hit' | 'stand' | 'double') =>
    post<BlackjackResponse>('/gambling/blackjack/action', { worldId, roundId, action }),
  startVideoPoker: (worldId: string, bet: number) => post<VideoPokerResponse>('/gambling/videopoker/start', { worldId, bet }),
  videoPokerDraw: (worldId: string, roundId: string, holds: boolean[]) =>
    post<VideoPokerResponse>('/gambling/videopoker/draw', { worldId, roundId, holds }),

  // minigames
  listMemorials: (worldId?: string) => get<string[]>(`/characters/memorials${worldQuery(worldId)}`),
  listMinigames: () => get<MinigameInfo[]>('/minigames'),
  startMinigame: (input: MinigameStart) => post<MinigameStartResponse>('/minigames/start', input),
  finishMinigame: (input: MinigameFinish) => post<MinigameFinishResponse>('/minigames/finish', input),
  minigameResults: (worldId?: string) => get<MinigameResult[]>(`/minigames/results${worldQuery(worldId)}`),

  // phone (worldId scopes results to the active world)
  phoneInbox: (worldId?: string) => get<PhoneInbox>(`/phone/inbox${worldQuery(worldId)}`),
  phoneThreads: (worldId?: string) => get<PhoneThreadSummary[]>(`/phone/threads${worldQuery(worldId)}`),
  phoneContacts: (worldId?: string) =>
    get<Array<{ id: string; name: string; portraitAssetId: string | null; available: boolean; unavailableReason: string | null }>>(
      `/phone/contacts${worldQuery(worldId)}`,
    ),
  phoneThread: (characterId: string) =>
    get<{ character: Character; messages: TextMessage[]; available: boolean; unavailableReason: string | null }>(
      `/phone/threads/${characterId}`,
    ),
  phoneSend: (
    characterId: string,
    text: string,
    imageAssetId: string | null = null,
    giftId: string | null = null,
  ) =>
    post<{
      playerMessage: TextMessage;
      reply: TextMessage | null;
      error: string | null;
      relationshipDelta: Partial<Record<string, number>>;
      giftReaction?: { line: string; expression: string; sentiment: 'positive' | 'neutral' | 'negative'; itemName: string } | null;
    }>(`/phone/threads/${characterId}/send`, { text, imageAssetId, giftId }),
  phoneClaimGift: (textId: string) =>
    post<{ item: ShopItem; inventoryItem: InventoryItem }>(`/phone/messages/${textId}/claim-gift`),
  phoneEmails: (worldId?: string) => get<Email[]>(`/phone/emails${worldQuery(worldId)}`),
  phoneReadEmail: (id: string) => post<Email>(`/phone/emails/${id}/read`),

  // faces (in-world social feed; worldId scopes results to the active world)
  facesFeed: (worldId?: string) => get<FeedView>(`/phone/feed${worldQuery(worldId)}`),
  facesPost: (body: string, worldId: string) =>
    post<CreateFeedPostResponse>('/phone/feed/posts', { body, worldId }),
  facesReact: (postId: string, kind: ReactionKind) =>
    post<FeedPostView>(`/phone/feed/posts/${postId}/react`, { kind }),
  facesComment: (postId: string, body: string) =>
    post<FeedPostView>(`/phone/feed/posts/${postId}/comment`, { body }),
  facesSeen: (worldId: string) => post<{ ok: true }>('/phone/feed/seen', { worldId }),

  // activities (work / together)
  listActivities: () => get<ActivityDef[]>('/activities'),
  performActivity: (input: PerformActivity) =>
    post<{
      activityId: string;
      kind: string;
      money: number;
      relationship: Relationship | null;
      together: TogetherResult | null;
      state: WorldState;
      skill: string | null;
      skillLevel: number;
      skillLeveledUp: boolean;
    }>('/activities/perform', input),

  // share files (export/import of characters + worlds as .hmchr/.hmwrld/.hmpack)
  exportCharacterFile: (id: string, name: string) =>
    downloadShareFile(`/packs/character/${id}`, {}, `${name || 'character'}.hmchr`),
  exportWorldFile: (id: string, name: string, includeCharacters = true) =>
    downloadShareFile(
      `/packs/world/${id}${includeCharacters ? '' : '?includeCharacters=false'}`,
      {},
      `${name || 'world'}.hmwrld`,
    ),
  exportBundleFile: (selection: {
    worldIds: string[];
    characterIds: string[];
    includeCharacters?: boolean;
    title?: string;
    note?: string;
  }) =>
    downloadShareFile(
      '/packs/export',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(selection) },
      'heartmorrow-bundle.hmpack',
    ),
  inspectPackFile: (file: File) => postShareFile<PackInspectResult>('/packs/inspect', file),
  importPackFile: (file: File, targetWorldId?: string, includeCharacters = true) => {
    const params = new URLSearchParams();
    if (targetWorldId) params.set('targetWorldId', targetWorldId);
    if (!includeCharacters) params.set('includeCharacters', 'false');
    const qs = params.toString();
    return postShareFile<PackImportResult>(`/packs/import${qs ? `?${qs}` : ''}`, file);
  },

  // data / debug
  listEvents: () => get<GameEvent[]>('/events'),
  listEndings: (worldId?: string) => get<CharacterEnding[]>(`/endings${worldQuery(worldId)}`),
  exportData: () => get<unknown>('/export'),
  importData: (bundle: unknown) => post<{ imported: true }>('/import', bundle),
  resetData: () => post<{ reset: true }>('/reset'),
};
