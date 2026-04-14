import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from './supabaseClient';

type Role = 'coach' | 'player' | null;

type Category = 'technical' | 'game';
type SubCategory =
  | 'driver'
  | 'iron'
  | 'putting'
  | 'spin'
  | 'shot_consistency'
  | '18hole'
  | 'chipside'
  | 'approach'
  | 'troubleshot'
  | 'clubdistance';

type Mission = {
  id: number;
  title: string;
  description: string;
  description_raw?: string;
  category: Category;
  subcategory: SubCategory;
  created_by: string;
  assigned_to: string;
  assigned_name?: string;
  attachments?: { name: string; url: string; path: string; bucket?: string }[];
  inserted_at?: string;
};

const subcategories: Record<Category, { key: SubCategory; label: string }[]> = {
  technical: [
    { key: 'driver', label: '드라이버 미션' },
    { key: 'iron', label: '아이언 미션' },
    { key: 'putting', label: '퍼팅 미션' },
    { key: 'spin', label: '스핀샷 미션' },
    { key: 'shot_consistency', label: '샷 일관성 미션' }
  ],
  game: [
    { key: '18hole', label: '18홀 가상 라운드' },
    { key: 'chipside', label: '그린사이드 칩샷' },
    { key: 'approach', label: '100야드 이내 어프로치' },
    { key: 'troubleshot', label: '트러블 샷' },
    { key: 'clubdistance', label: '클럽 기본거리 확인' }
  ]
};

type User = {
  id: string;
  role: 'coach' | 'player';
  coach_code: string;
  username?: string;
  display_name?: string;
  encrypted_password?: string;
};

type MissionLog = {
  id: number;
  mission_id: number;
  player_id: string;
  status: 'pending' | 'completed';
  note: string;
  coach_feedback: string | null;
  created_at: string;
  attachments?: { name: string; url: string; path: string }[];
};

type AttachmentMeta = { name: string; url: string; path: string; bucket?: string };

type TemplateFieldType = 'text' | 'number' | 'select';

type MissionTemplateField = {
  key: string;
  label: string;
  type: TemplateFieldType;
  required: boolean;
  options?: string[];
  placeholder?: string;
  helpText?: string;
};

type TemplateMode = 'form' | 'grid';

type GridTemplateConfig = {
  title: string;
  rowCount: number;
  colCount: number;
  rowHeaders: string[];
  colHeaders: string[];
  successThreshold: number;
};

type MissionTemplate = {
  mission_id: number;
  version: number;
  status: 'draft' | 'published';
  schema_json: {
    mode?: TemplateMode;
    fields: MissionTemplateField[];
    grid?: GridTemplateConfig;
  };
};

type MissionDraftPayload = {
  noteText: string;
  templateValues: Record<string, string>;
  templateSchema?: MissionTemplate['schema_json'] | null;
};

const MISSION_TEMPLATE_DISABLED_STORAGE_KEY = 'mission_template_table_missing';
const MISSION_DRAFT_STORAGE_PREFIX = 'mission_draft_v1';
const MISSION_TEMPLATE_INLINE_PREFIX = '[MISSION_TEMPLATE_INLINE:';
const MISSION_TEMPLATE_INLINE_SUFFIX = ']';
let missionTemplateMissingGlobal = false;
let missionTemplateLookupInFlight = false;

const encodeBase64Utf8 = (value: string) => {
  return btoa(unescape(encodeURIComponent(value)));
};

const decodeBase64Utf8 = (value: string) => {
  return decodeURIComponent(escape(atob(value)));
};

const buildMissionDescriptionWithInlineTemplate = (
  description: string,
  schemaJson: MissionTemplate['schema_json'] | null
) => {
  const clean = (description || '').trim();
  if (!schemaJson) return clean;
  try {
    const encoded = encodeBase64Utf8(JSON.stringify(schemaJson));
    return `${clean}\n${MISSION_TEMPLATE_INLINE_PREFIX}${encoded}${MISSION_TEMPLATE_INLINE_SUFFIX}`;
  } catch {
    return clean;
  }
};

const parseMissionDescriptionInlineTemplate = (
  rawDescription: string | null | undefined
): { cleanDescription: string; inlineTemplate: MissionTemplate['schema_json'] | null } => {
  const text = rawDescription || '';
  const markerStart = text.lastIndexOf(MISSION_TEMPLATE_INLINE_PREFIX);
  if (markerStart < 0) {
    return { cleanDescription: text, inlineTemplate: null };
  }

  const markerEnd = text.indexOf(MISSION_TEMPLATE_INLINE_SUFFIX, markerStart + MISSION_TEMPLATE_INLINE_PREFIX.length);
  if (markerEnd < 0) {
    return { cleanDescription: text, inlineTemplate: null };
  }

  const encoded = text.slice(markerStart + MISSION_TEMPLATE_INLINE_PREFIX.length, markerEnd).trim();
  const cleanDescription = text.slice(0, markerStart).trimEnd();

  try {
    const parsed = JSON.parse(decodeBase64Utf8(encoded));
    if (parsed && typeof parsed === 'object') {
      return { cleanDescription, inlineTemplate: parsed as MissionTemplate['schema_json'] };
    }
  } catch {
    // 인라인 템플릿 파싱 실패 시 일반 설명으로 폴백.
  }

  return { cleanDescription, inlineTemplate: null };
};

const getMissionDraftStorageKey = (playerId: string, missionId: number) => {
  return `${MISSION_DRAFT_STORAGE_PREFIX}:${playerId}:${missionId}`;
};

function App() {
  const [role, setRole] = useState<Role>(null);
  const isCoach = role === 'coach';
  const [loginId, setLoginId] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [requestedUsername, setRequestedUsername] = useState('');
  const [requestedPassword, setRequestedPassword] = useState('');
  const [requestedDisplayName, setRequestedDisplayName] = useState('');
  const [currentPlayer, setCurrentPlayer] = useState<string | null>(null);
  const [currentCoach, setCurrentCoach] = useState<string | null>(null);
  const [category, setCategory] = useState<Category | null>(null);
  const [subcategory, setSubcategory] = useState<SubCategory | null>(null);
  const [missions, setMissions] = useState<Mission[]>([]);
  const [players, setPlayers] = useState<User[]>([]);
  const [newMission, setNewMission] = useState({ id: '', title: '', description: '' });
  const [editingMissionId, setEditingMissionId] = useState<number | null>(null);
  const [assignTo, setAssignTo] = useState('all');
  const UNASSIGNED_CODE = 'unassigned';
  const UNASSIGNED_LABEL = '미정';
  const [missionFiles, setMissionFiles] = useState<File[]>([]);
  const [newMissionTemplateFields, setNewMissionTemplateFields] = useState<MissionTemplateField[]>([]);
  const [newTemplateMode, setNewTemplateMode] = useState<TemplateMode>('form');
  const [newGridTitle, setNewGridTitle] = useState('');
  const [newGridRows, setNewGridRows] = useState(6);
  const [newGridCols, setNewGridCols] = useState(4);
  const [newGridRowHeaders, setNewGridRowHeaders] = useState<string[]>([]);
  const [newGridColHeaders, setNewGridColHeaders] = useState<string[]>([]);
  const [newGridSuccessThreshold, setNewGridSuccessThreshold] = useState(1);
  const [isTemplatePublishedForNewMission, setIsTemplatePublishedForNewMission] = useState(false);
  const [showTemplateDesigner, setShowTemplateDesigner] = useState(false);
  const [templateTableAvailable, setTemplateTableAvailable] = useState(() => {
    if (missionTemplateMissingGlobal) return false;
    if (typeof window === 'undefined') return true;
    return window.localStorage.getItem(MISSION_TEMPLATE_DISABLED_STORAGE_KEY) !== '1';
  });
  const [missionTemplates, setMissionTemplates] = useState<Record<number, MissionTemplate>>({});
  const [storageBucket, setStorageBucket] = useState('attachments');
  const [missionLogs, setMissionLogs] = useState<MissionLog[]>([]);
  const [assignModalMission, setAssignModalMission] = useState<Mission | null>(null);
  const [assignTarget, setAssignTarget] = useState('');
  const [coachFeedback, setCoachFeedback] = useState<Record<number, string>>({});
  const [playerMissionNotes, setPlayerMissionNotes] = useState<Record<number, string>>({});
  const [playerMissionFiles, setPlayerMissionFiles] = useState<Record<number, File[]>>({});
  const [playerDraftAttachments, setPlayerDraftAttachments] = useState<Record<number, AttachmentMeta[]>>({});
  const [playerTemplateValues, setPlayerTemplateValues] = useState<Record<number, Record<string, string>>>({});
  const [draftSaveStatus, setDraftSaveStatus] = useState<Record<number, string>>({});

  const [showShotConsistencyPanel, setShowShotConsistencyPanel] = useState(false);
  const [shotConsistencyUrl, setShotConsistencyUrl] = useState('');
  const [shotPanelMode, setShotPanelMode] = useState<'fullscreen' | 'window'>('window');
  const [playerReply, setPlayerReply] = useState<Record<number, string>>({});
  const [missionReply, setMissionReply] = useState<Record<number, string>>({});
  const [showVerificationPanel, setShowVerificationPanel] = useState(false);
  const [selectedMissionId, setSelectedMissionId] = useState<number | null>(null);
  const [selectedPlayerMissionId, setSelectedPlayerMissionId] = useState<number | null>(null);
  const [playerMissionChat, setPlayerMissionChat] = useState<Record<number, string>>({});
  const [verifiedPlayers, setVerifiedPlayers] = useState<Record<string, boolean>>({});
  const [viewedMissionIds, setViewedMissionIds] = useState<number[]>([]);
  const [showMineOnly, setShowMineOnly] = useState(false);
  const [missionFilter, setMissionFilter] = useState<'all' | 'latest' | 'pending' | 'completed'>('all');
  const [showAssignedOnly, setShowAssignedOnly] = useState(false);
  const [showSubcategoryDropdown, setShowSubcategoryDropdown] = useState(false);
  const [playerPasswordInputs, setPlayerPasswordInputs] = useState<Record<string, string>>({});
  const missingBucketsRef = useRef<Set<string>>(new Set());
  const lastSavedDraftNoteRef = useRef<Record<number, string>>({});
  const lastSavedDraftPayloadRef = useRef<Record<number, string>>({});
  const missionTemplateErrorNotifiedRef = useRef(false);
  const missionTemplateDisabledRef = useRef(false);
  const missionTemplateTableConfirmedRef = useRef(false);
  const missionLogAttachmentsAvailableRef = useRef<boolean | null>(null);

  const filteredMissions = useMemo(() => {
    if (!category || !subcategory) return [];
    const categoryFiltered = missions.filter(m => m.category === category && m.subcategory === subcategory);
    if (role === 'player' && currentPlayer) {
      return categoryFiltered.filter(m => m.assigned_to === 'all' || m.assigned_to === currentPlayer);
    }
    return categoryFiltered;
  }, [missions, category, subcategory, role, currentPlayer]);

  const unassignedMissions = useMemo(() => {
    return filteredMissions.filter(m => m.assigned_to === UNASSIGNED_CODE || m.assigned_to === UNASSIGNED_LABEL);
  }, [filteredMissions]);

  const assignedMissions = useMemo(() => {
    return filteredMissions.filter(m => !(m.assigned_to === UNASSIGNED_CODE || m.assigned_to === UNASSIGNED_LABEL));
  }, [filteredMissions]);

  const visibleMissions = selectedMissionId !== null ? filteredMissions.filter(m => m.id === selectedMissionId) : [];

  const myMissionLogs = useMemo(() => {
    return missionLogs.filter(log => log.player_id === currentPlayer);
  }, [missionLogs, currentPlayer]);

  const missionLogsByMission = myMissionLogs.reduce<Record<number, MissionLog[]>>((acc, log) => {
    if (!acc[log.mission_id]) acc[log.mission_id] = [];
    acc[log.mission_id].push(log);
    return acc;
  }, {});

  const latestMissionStatusById = useMemo(() => {
    const sorted = [...myMissionLogs].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
    const statusMap: Record<number, 'pending' | 'completed'> = {};
    for (const log of sorted) {
      if (!statusMap[log.mission_id]) {
        statusMap[log.mission_id] = log.status;
      }
    }
    return statusMap;
  }, [myMissionLogs]);

  const selectedPlayerMissionStatus = useMemo(() => {
    if (!selectedPlayerMissionId) return undefined;
    return latestMissionStatusById[selectedPlayerMissionId];
  }, [latestMissionStatusById, selectedPlayerMissionId]);

  const parseMissionDraftPayload = (rawNote: unknown): MissionDraftPayload => {
    if (rawNote === null || rawNote === undefined) {
      return { noteText: '', templateValues: {}, templateSchema: null };
    }

    const normalizePayloadObject = (obj: any): MissionDraftPayload | null => {
      if (!obj || typeof obj !== 'object') return null;

      const hasDraftShape =
        Object.prototype.hasOwnProperty.call(obj, 'noteText') ||
        Object.prototype.hasOwnProperty.call(obj, 'templateValues') ||
        Object.prototype.hasOwnProperty.call(obj, 'templateSchema');
      if (!hasDraftShape) return null;

      const noteText =
        typeof obj.noteText === 'string'
          ? obj.noteText
          : typeof obj.note === 'string'
          ? obj.note
          : '';

      const templateValues =
        obj.templateValues && typeof obj.templateValues === 'object' ? obj.templateValues : {};
      const templateSchema =
        obj.templateSchema && typeof obj.templateSchema === 'object'
          ? (obj.templateSchema as MissionTemplate['schema_json'])
          : null;

      return { noteText, templateValues, templateSchema };
    };

    if (typeof rawNote === 'object') {
      const normalized = normalizePayloadObject(rawNote as any);
      if (normalized) return normalized;
      return { noteText: JSON.stringify(rawNote), templateValues: {}, templateSchema: null };
    }

    if (typeof rawNote !== 'string') {
      return { noteText: String(rawNote), templateValues: {}, templateSchema: null };
    }

    const trimmed = rawNote.trim();
    if (!trimmed) return { noteText: '', templateValues: {}, templateSchema: null };

    try {
      let parsed: any = JSON.parse(trimmed);
      if (typeof parsed === 'string') {
        try {
          parsed = JSON.parse(parsed);
        } catch {
          return { noteText: parsed, templateValues: {}, templateSchema: null };
        }
      }

      const normalized = normalizePayloadObject(parsed);
      if (normalized) return normalized;
    } catch {
      // plain text note fallback
    }

    return { noteText: rawNote, templateValues: {}, templateSchema: null };
  };

  const buildMissionDraftPayload = (missionId: number, noteText: string): string => {
    const payload: MissionDraftPayload = {
      noteText: noteText || '',
      templateValues: playerTemplateValues[missionId] || {},
      templateSchema: missionTemplates[missionId]?.schema_json || null,
    };
    return JSON.stringify(payload);
  };

  const getLogDisplayNote = (rawNote: unknown) => {
    return parseMissionDraftPayload(rawNote).noteText || '없음';
  };

  const getTemplateValueSummary = (missionId: number, rawNote: unknown) => {
    const parsed = parseMissionDraftPayload(rawNote);
    const values = parsed.templateValues || {};
    const nonEmptyEntries = Object.entries(values).filter(([, v]) => `${v ?? ''}`.trim() !== '');
    if (nonEmptyEntries.length === 0) return '없음';

    const templateFromPayload = parsed.templateSchema
      ? {
          mission_id: missionId,
          version: 1,
          status: 'published' as const,
          schema_json: parsed.templateSchema,
        }
      : null;
    const template = missionTemplates[missionId] || templateFromPayload;
    const mode = template?.schema_json?.mode || 'form';

    if (mode === 'grid' && template?.schema_json?.grid) {
      const grid = template.schema_json.grid;
      const previews = nonEmptyEntries.slice(0, 6).map(([key, value]) => {
        const match = key.match(/^cell_r(\d+)_c(\d+)$/);
        if (!match) return `${key}: ${value}`;
        const row = Number(match[1]);
        const col = Number(match[2]);
        const rowLabel = grid.rowHeaders[row] || `행${row + 1}`;
        const colLabel = grid.colHeaders[col] || `열${col + 1}`;
        return `${rowLabel}/${colLabel}: ${value}`;
      });
      return `${nonEmptyEntries.length}칸 입력 · ${previews.join(', ')}`;
    }

    const fieldsByKey = new Map((template?.schema_json?.fields || []).map(field => [field.key, field.label]));
    const previews = nonEmptyEntries.slice(0, 6).map(([key, value]) => `${fieldsByKey.get(key) || key}: ${value}`);
    return `${nonEmptyEntries.length}항목 입력 · ${previews.join(', ')}`;
  };

  const getTemplateTableRows = (missionId: number, rawNote: unknown) => {
    const parsed = parseMissionDraftPayload(rawNote);
    const values = parsed.templateValues || {};
    const nonEmptyEntries = Object.entries(values).filter(([, v]) => `${v ?? ''}`.trim() !== '');
    if (nonEmptyEntries.length === 0) return null;

    const templateFromPayload = parsed.templateSchema
      ? {
          mission_id: missionId,
          version: 1,
          status: 'published' as const,
          schema_json: parsed.templateSchema,
        }
      : null;
    const template = missionTemplates[missionId] || templateFromPayload;
    const mode = template?.schema_json?.mode || 'form';

    if (mode === 'grid' && template?.schema_json?.grid) {
      const grid = template.schema_json.grid;
      const rows = Array.from({ length: grid.rowCount }).map((_, r) => {
        const label = grid.rowHeaders[r] || `행 ${r + 1}`;
        const cells = Array.from({ length: grid.colCount }).map((__, c) => {
          const key = `cell_r${r}_c${c}`;
          return values[key] || '';
        });
        return { label, cells };
      });

      return {
        mode: 'grid' as const,
        title: grid.title || '입력 시트',
        headers: grid.colHeaders.map((h, i) => h || `열 ${i + 1}`),
        rows,
      };
    }

    const fieldsByKey = new Map((template?.schema_json?.fields || []).map(field => [field.key, field.label]));
    const rows = nonEmptyEntries.map(([key, value]) => ({
      label: fieldsByKey.get(key) || key,
      value: `${value}`,
    }));

    return {
      mode: 'form' as const,
      rows,
    };
  };

  const isMissingMissionTemplateTableError = (error: any) => {
    const errorText = `${error?.code || ''} ${error?.message || ''} ${error?.details || ''} ${error?.hint || ''}`.toLowerCase();
    return (
      errorText.includes('does not exist') ||
      errorText.includes('relation') ||
      errorText.includes('schema cache') ||
      errorText.includes('not found') ||
      error?.code === 'PGRST205'
    );
  };

  const isMissingMissionLogAttachmentsColumnError = (error: any) => {
    const errorText = `${error?.code || ''} ${error?.message || ''} ${error?.details || ''} ${error?.hint || ''}`.toLowerCase();
    return (
      errorText.includes('attachments') &&
      (errorText.includes('column') ||
        errorText.includes('does not exist') ||
        errorText.includes('schema cache') ||
        errorText.includes('not found') ||
        error?.code === 'PGRST204')
    );
  };

  const disableMissionTemplateFeature = () => {
    missionTemplateMissingGlobal = true;
    missionTemplateDisabledRef.current = true;
    setTemplateTableAvailable(false);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(MISSION_TEMPLATE_DISABLED_STORAGE_KEY, '1');
    }
    if (!missionTemplateErrorNotifiedRef.current) {
      console.warn('mission_templates 테이블이 없어 템플릿 기능 호출을 중단합니다. 테이블 생성 후 다시 사용 가능합니다.');
      missionTemplateErrorNotifiedRef.current = true;
    }
  };

  const publishMissionTemplate = async (missionId: number, schemaJson: MissionTemplate['schema_json']) => {
    if (missionTemplateDisabledRef.current || !templateTableAvailable) return;

    const latestTemplate = await supabase
      .from('mission_templates')
      .select('version')
      .eq('mission_id', missionId)
      .eq('status', 'published')
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latestTemplate.error) {
      if (isMissingMissionTemplateTableError(latestTemplate.error)) {
        disableMissionTemplateFeature();
      } else {
        console.warn('mission_templates 최신 버전 조회 실패:', latestTemplate.error.message);
      }
      return;
    }

    missionTemplateTableConfirmedRef.current = true;

    const nextVersion = (latestTemplate.data?.version ?? 0) + 1;
    const templateInsert = await supabase.from('mission_templates').insert([
      {
        mission_id: missionId,
        version: nextVersion,
        status: 'published',
        schema_json: schemaJson,
      }
    ]);

    if (templateInsert.error) {
      if (isMissingMissionTemplateTableError(templateInsert.error)) {
        disableMissionTemplateFeature();
      } else {
        console.warn('mission_templates 저장 실패:', templateInsert.error.message);
      }
    } else {
      missionTemplateTableConfirmedRef.current = true;
    }
  };

  const coachCompletedLogs = useMemo(() => {
    return [...missionLogs]
      .filter(log => log.status === 'completed')
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }, [missionLogs]);

  const coachCompletedSummary = useMemo(() => {
    const completedCount = coachCompletedLogs.length;
    const uniquePlayerCount = new Set(coachCompletedLogs.map(log => log.player_id)).size;
    const recentCompletedAt = coachCompletedLogs[0]?.created_at || null;
    const missionCounter: Record<number, number> = {};

    coachCompletedLogs.forEach(log => {
      missionCounter[log.mission_id] = (missionCounter[log.mission_id] || 0) + 1;
    });

    const missionRanking = Object.entries(missionCounter)
      .map(([missionId, count]) => {
        const idNum = Number(missionId);
        const mission = missions.find(m => m.id === idNum);
        return {
          missionId: idNum,
          count,
          title: mission?.title || `미션 #${missionId}`,
        };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return { completedCount, uniquePlayerCount, recentCompletedAt, missionRanking };
  }, [coachCompletedLogs, missions]);

  const loadMissions = async () => {
    const { data, error } = await supabase
      .from('missions')
      .select('*')
      .order('id', { ascending: false });

    if (error) {
      console.error('Failed to load missions:', error);
      return;
    }

    if (data) {
      const inlineTemplateMap: Record<number, MissionTemplate> = {};

      const missionsWithNames = (data as Mission[]).map(m => {
        const parsedInline = parseMissionDescriptionInlineTemplate(m.description);
        const normalizedAssignedTo = m.assigned_to === UNASSIGNED_LABEL ? UNASSIGNED_CODE : m.assigned_to;
        const player = players.find(p => p.id === normalizedAssignedTo);
        const assignedName = player
          ? player.display_name || player.username || player.id
          : normalizedAssignedTo === UNASSIGNED_CODE
          ? UNASSIGNED_LABEL
          : normalizedAssignedTo;

        if (parsedInline.inlineTemplate) {
          inlineTemplateMap[m.id] = {
            mission_id: m.id,
            version: 1,
            status: 'published',
            schema_json: parsedInline.inlineTemplate,
          };
        }

        return {
          ...m,
          description: parsedInline.cleanDescription,
          description_raw: m.description,
          assigned_to: normalizedAssignedTo,
          assigned_name: assignedName,
        };
      });
      setMissions(missionsWithNames);
      if (Object.keys(inlineTemplateMap).length > 0) {
        setMissionTemplates(prev => {
          const merged = { ...prev };
          Object.entries(inlineTemplateMap).forEach(([missionId, template]) => {
            const id = Number(missionId);
            if (!merged[id]) {
              merged[id] = template;
            }
          });
          return merged;
        });
      }
    }
  };

  const loadPlayers = async () => {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('role', 'player');

    if (error) {
      console.error('Failed to load players:', error);
      return;
    }

    if (data) {
      setPlayers(data);
      const verified: Record<string, boolean> = {};
      data.forEach(p => {
        // verified 컬럼이 존재하면 사용, 아니면 false
        const v = (p as any).verified;
        verified[p.id] = v === true || v === 't' || v === 'true' || v === '1';
      });
      setVerifiedPlayers(verified);
    }
  };

  const ensureMissionBucket = async () => {
    try {
      const { data: buckets, error: listError } = await supabase.storage.listBuckets();
      if (listError) {
        console.warn('버킷 목록 조회 실패 (읽기 권한 문제 가능):', listError);
      }

      if (buckets && buckets.length > 0) {
        const existing = new Set(buckets.map(b => b.name));
        ['attachments', 'mission-files'].forEach(name => {
          if (!existing.has(name)) {
            missingBucketsRef.current.add(name);
          }
        });
      }

      if (buckets?.some(b => b.name === 'attachments')) {
        setStorageBucket('attachments');
        return;
      }

      if (buckets?.some(b => b.name === 'mission-files')) {
        setStorageBucket('mission-files');
        return;
      }

      console.warn('기존 버킷이 없거나 권한 없음. attachments를 우선 사용합니다.');
      setStorageBucket('attachments');
      return;
    } catch (bucketError) {
      console.warn('버킷 목록 조회 중 예외(권한 제한 가능). attachments 우선 사용:', bucketError);
      setStorageBucket('attachments');
      return;
    }
  };

  const openAttachment = async (file: {name:string;path:string;url?:string;bucket?:string}) => {
    const isSignedUrlWithoutToken = (url: string) => {
      return /\/storage\/v1\/object\/sign\//.test(url) && !/[?&]token=/.test(url);
    };

    const parseBucketAndPathFromUrl = (url: string): { bucket: string; path: string } | null => {
      const signMatch = url.match(/storage\/v1\/object\/sign\/([^/]+)\/([^?]+)/);
      if (signMatch) {
        return { bucket: signMatch[1], path: decodeURIComponent(signMatch[2]) };
      }

      const publicMatch = url.match(/storage\/v1\/object\/public\/([^/]+)\/(.+)$/);
      if (publicMatch) {
        return { bucket: publicMatch[1], path: decodeURIComponent(publicMatch[2]) };
      }

      return null;
    };

    const buildBucketCandidates = () => {
      const candidates = [file.bucket, storageBucket];
      return Array.from(new Set(candidates.filter(Boolean) as string[])).filter(
        b => !missingBucketsRef.current.has(b)
      );
    };

    const openByBlobDownload = async (bucket: string, objectPath: string) => {
      const trimmedPath = objectPath.replace(/^\/+/, '');
      const { data, error } = await supabase.storage.from(bucket).download(trimmedPath);
      if (error || !data) {
        const msg = error?.message || '';
        if (/bucket not found/i.test(msg)) {
          missingBucketsRef.current.add(bucket);
        }
        return false;
      }

      const blobUrl = URL.createObjectURL(data);
      const opened = window.open(blobUrl, '_blank');
      if (!opened) {
        const a = document.createElement('a');
        a.href = blobUrl;
        a.target = '_blank';
        a.rel = 'noreferrer';
        a.download = file.name || '';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }

      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
      return true;
    };

    const findReplacementObjectPath = async (bucket: string, originalFileName: string, originalPath?: string) => {
      const normalizedFileName = (originalFileName || '').trim().toLowerCase();
      const originalBaseName = (originalPath || '').split('/').pop()?.trim().toLowerCase() || '';

      const tokenMatch = originalBaseName.match(/^mission_\d+_[a-z0-9]+_(.+)$/i);
      const normalizedSuffixToken = tokenMatch?.[1] || '';

      const { data, error } = await supabase.storage.from(bucket).list('', { limit: 1000 });
      if (error || !data || data.length === 0) {
        return '';
      }

      const scored = data
        .filter(item => !!item.name)
        .map(item => {
          const name = item.name.toLowerCase();
          let score = 0;
          if (normalizedFileName && name.endsWith(`_${normalizedFileName}`)) score += 5;
          if (normalizedFileName && name.includes(normalizedFileName)) score += 3;
          if (normalizedSuffixToken && name.endsWith(normalizedSuffixToken)) score += 7;
          if (originalBaseName && name === originalBaseName) score += 10;
          return { item, score };
        })
        .filter(entry => entry.score > 0);

      if (scored.length === 0) {
        return '';
      }

      const candidates = scored.map(entry => entry.item);
      const sorted = [...candidates].sort((a, b) => {
        const ta = new Date(a.updated_at || a.created_at || 0).getTime();
        const tb = new Date(b.updated_at || b.created_at || 0).getTime();
        return tb - ta;
      });
      return sorted[0]?.name || '';
    };

    const resolveExistingObjectPath = async (bucket: string, requestedPath: string, originalFileName: string) => {
      const trimmed = (requestedPath || '').replace(/^\/+/, '');
      const baseName = trimmed.split('/').pop()?.trim() || '';
      if (!baseName) return '';

      const { data, error } = await supabase.storage.from(bucket).list('', { limit: 1000 });
      if (error || !data || data.length === 0) {
        return '';
      }

      const exact = data.find(item => item.name === trimmed || item.name === baseName);
      if (exact?.name) return exact.name;

      const matchedByName = await findReplacementObjectPath(bucket, originalFileName || baseName, trimmed);
      return matchedByName || '';
    };

    const downloadCandidates: { bucket: string; path: string }[] = [];

    if (file.path) {
      const normalizedPath = file.path.trim().replace(/^\/+/, '');
      const parts = normalizedPath.split('/');
      if (parts.length > 1 && ['mission-files', 'attachments'].includes(parts[0])) {
        const directBucket = parts[0];
        const objectPath = parts.slice(1).join('/');
        downloadCandidates.push({ bucket: directBucket, path: objectPath });
      }

      buildBucketCandidates().forEach(bucket => {
        downloadCandidates.push({ bucket, path: normalizedPath });
      });
    }

    if (file.url) {
      const parsed = parseBucketAndPathFromUrl(file.url);
      if (parsed) {
        downloadCandidates.push(parsed);
      }
    }

    const dedupedDownloadCandidates = Array.from(
      new Map(downloadCandidates.map(c => [`${c.bucket}::${c.path}`, c])).values()
    );

    for (const candidate of dedupedDownloadCandidates) {
      try {
        const existingPath = await resolveExistingObjectPath(candidate.bucket, candidate.path, file.name || '');
        if (!existingPath) {
          continue;
        }

        const ok = await openByBlobDownload(candidate.bucket, existingPath);
        if (ok) {
          return;
        }
      } catch (err) {
        console.debug('openAttachment blob 다운로드 실패:', candidate, err);
      }
    }

    const repairBuckets = Array.from(new Set(dedupedDownloadCandidates.map(c => c.bucket)));
    for (const bucket of repairBuckets) {
      if (!bucket || missingBucketsRef.current.has(bucket)) continue;
      try {
        const replacementPath = await findReplacementObjectPath(bucket, file.name || '', file.path || '');
        if (!replacementPath) continue;
        const recovered = await openByBlobDownload(bucket, replacementPath);
        if (recovered) {
          console.warn('openAttachment: 경로 불일치 파일 복구 열기 성공', {
            bucket,
            originalPath: file.path,
            replacementPath
          });
          return;
        }
      } catch (err) {
        console.debug('openAttachment 복구 탐색 실패:', bucket, err);
      }
    }

    const urlCandidates: string[] = [];
    if (file.url && !isSignedUrlWithoutToken(file.url)) {
      urlCandidates.push(file.url);
    }

    for (const url of urlCandidates) {
      try {
        console.debug('openAttachment 시도 URL:', url);
        const opened = window.open(url, '_blank');
        if (!opened) {
          // 팝업 차단 등으로 새 탭 열기 실패하면 강제 파일 링크 클릭
          const a = document.createElement('a');
          a.href = url;
          a.target = '_blank';
          a.rel = 'noreferrer';
          a.download = file.name || '';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        }
        return;
      } catch (err) {
        console.debug('openAttachment URL 실패:', url, err);
        continue;
      }
    }

    alert('첨부파일을 가져올 수 없습니다. Supabase 버킷 설정을 확인하거나 파일이 삭제되었는지 확인하세요.');
  };

  const cleanOldAttachments = async () => {
    const maxAgeDays = 30;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - maxAgeDays);

    const { data: missionsToCleanup, error: cleanupError } = await supabase
      .from('missions')
      .select('id, attachments, inserted_at')
      .not('attachments', 'is', 'null');

    if (cleanupError) {
      console.warn('미션 정리 쿼리 오류:', cleanupError);
      return;
    }

    if (!missionsToCleanup) return;

    for (const mod of missionsToCleanup as Mission[]) {
      if (!mod.attachments?.length || !mod.inserted_at) continue;
      const created = new Date(mod.inserted_at);
      if (isNaN(created.getTime()) || created > cutoff) continue;

      for (const attachment of mod.attachments) {
        const { error: removeError } = await supabase.storage.from(storageBucket).remove([attachment.path]);
        if (removeError) {
          console.warn('첨부파일 자동 삭제 중 오류:', attachment.path, removeError);
        }
      }

      await supabase.from('missions').update({ attachments: [] }).eq('id', mod.id);
    }
  };

  const loadMissionLogs = async () => {
    const { data, error } = await supabase
      .from('mission_logs')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Failed to load mission logs:', error);
      return;
    }

    if (data) setMissionLogs(data);
  };

  const loadMissionTemplates = async (missionIds: number[]) => {
    if (
      missionTemplateMissingGlobal ||
      missionTemplateDisabledRef.current ||
      missionTemplateLookupInFlight ||
      !templateTableAvailable ||
      missionIds.length === 0
    ) {
      return;
    }

    const uniqueMissionIds = Array.from(new Set(missionIds));
    missionTemplateLookupInFlight = true;

    const { data, error } = await supabase
      .from('mission_templates')
      .select('mission_id, version, status, schema_json')
      .in('mission_id', uniqueMissionIds)
      .eq('status', 'published')
      .order('version', { ascending: false });

    missionTemplateLookupInFlight = false;

    if (error) {
      if (isMissingMissionTemplateTableError(error)) {
        disableMissionTemplateFeature();
      } else {
        console.warn('mission_templates 조회 실패:', error.message);
      }
      return;
    }

    missionTemplateTableConfirmedRef.current = true;

    if (!data) return;

    const mapped: Record<number, MissionTemplate> = {};
    (data as MissionTemplate[]).forEach(t => {
      if (!mapped[t.mission_id]) mapped[t.mission_id] = t;
    });
    setMissionTemplates(prev => {
      const merged = { ...prev };
      Object.entries(mapped).forEach(([missionId, template]) => {
        merged[Number(missionId)] = template;
      });
      return merged;
    });
  };

  useEffect(() => {
    const init = async () => {
      await loadPlayers();
      await loadMissions();
      await loadMissionLogs();
      await cleanOldAttachments();
    };
    init();
  }, []);

  useEffect(() => {
    if (!missions.length) return;
    loadMissionTemplates(missions.map(m => m.id));
  }, [missions, templateTableAvailable]);

  useEffect(() => {
    setNewGridRowHeaders(prev => {
      const next = [...prev];
      while (next.length < newGridRows) next.push(`조건 ${next.length + 1}`);
      return next.slice(0, newGridRows);
    });
  }, [newGridRows]);

  useEffect(() => {
    setNewGridColHeaders(prev => {
      const next = [...prev];
      while (next.length < newGridCols) next.push(`항목 ${next.length + 1}`);
      return next.slice(0, newGridCols);
    });
  }, [newGridCols]);

  const handleLogin = async () => {
    if (!loginId.trim()) return alert('아이디를 입력해주세요');
    if (!loginPassword.trim()) return alert('비밀번호를 입력해주세요');

    // 1) 코치 계정 우선 조회 (role=coach)
    let result = await supabase
      .from('users')
      .select('*')
      .match({ role: 'coach', coach_code: loginId })
      .maybeSingle();

    // 2) 코치가 아니라면 선수 계정 조회 (role=player)
    if (!result.data && !result.error) {
      result = await supabase
        .from('users')
        .select('*')
        .match({ role: 'player', username: loginId })
        .maybeSingle();
    }

    const { data, error } = result;
    if (error) {
      console.error('로그인 쿼리 에러', error);
      return alert('로그인 처리 중 오류가 발생했습니다.');
    }
    if (!data) {
      return alert('유효한 계정이 없습니다. 아이디를 확인해주세요.');
    }

    if (!data.encrypted_password || data.encrypted_password !== loginPassword) {
      return alert('비밀번호가 일치하지 않습니다.');
    }

    const isVerifiedPlayer =
      data.role !== 'player' ||
      data.verified === true ||
      data.verified === 't' ||
      data.verified === 'true' ||
      data.verified === '1';

    if (!isVerifiedPlayer) {
      return alert('인증되지 않은 선수입니다. 코치에게 인증을 요청하세요.');
    }

    setRole(data.role);
    setCurrentPlayer(data.role === 'player' ? data.id : null);
    setCurrentCoach(data.coach_code);
    // 로그인 성공 메시지 제거: 바로 진입
    // alert(`${data.role === 'coach' ? '코치' : '선수'} 로그인 성공`);

  };

  const resetMissionEditor = () => {
    setEditingMissionId(null);
    setNewMission({ id: '', title: '', description: '' });
    setAssignTo('all');
    setMissionFiles([]);
    setNewMissionTemplateFields([]);
    setNewTemplateMode('form');
    setNewGridTitle('');
    setNewGridRows(6);
    setNewGridCols(4);
    setNewGridRowHeaders([]);
    setNewGridColHeaders([]);
    setNewGridSuccessThreshold(1);
    setIsTemplatePublishedForNewMission(false);
  };

  const loadMissionIntoEditor = (mission: Mission) => {
    const inlineTemplate = parseMissionDescriptionInlineTemplate(mission.description_raw || mission.description).inlineTemplate;
    const schema = missionTemplates[mission.id]?.schema_json || inlineTemplate;

    setEditingMissionId(mission.id);
    setSelectedMissionId(mission.id);
    setCategory(mission.category);
    setSubcategory(mission.subcategory);
    setNewMission({ id: String(mission.id), title: mission.title, description: mission.description });
    setAssignTo(mission.assigned_to === UNASSIGNED_LABEL ? UNASSIGNED_CODE : mission.assigned_to);
    setMissionFiles([]);

    if (schema) {
      const mode = schema.mode || 'form';
      setIsTemplatePublishedForNewMission(true);
      setNewTemplateMode(mode);
      if (mode === 'grid' && schema.grid) {
        setNewGridTitle(schema.grid.title || mission.title);
        setNewGridRows(schema.grid.rowCount || 6);
        setNewGridCols(schema.grid.colCount || 4);
        setNewGridRowHeaders(schema.grid.rowHeaders || []);
        setNewGridColHeaders(schema.grid.colHeaders || []);
        setNewGridSuccessThreshold(schema.grid.successThreshold || 1);
        setNewMissionTemplateFields([]);
      } else {
        setNewMissionTemplateFields(schema.fields || []);
      }
    } else {
      setIsTemplatePublishedForNewMission(false);
      setNewTemplateMode('form');
      setNewMissionTemplateFields([]);
    }
  };

  const handleAddMission = async () => {
    if (!currentCoach) {
      alert('코치로 로그인된 상태여야 합니다.');
      return;
    }

    const isEditMode = editingMissionId !== null;

    if (!newMission.title.trim() || !newMission.description.trim()) {
      alert('미션 제목/설명을 모두 입력해주세요.');
      return;
    }

    if (!category || !subcategory) {
      alert('카테고리와 서브카테고리를 선택해주세요.');
      return;
    }

    const hasFormTemplate = newTemplateMode === 'form' && newMissionTemplateFields.length > 0;
    const hasGridTemplate =
      newTemplateMode === 'grid' &&
      newGridRows > 0 &&
      newGridCols > 0 &&
      newGridRowHeaders.length === newGridRows &&
      newGridColHeaders.length === newGridCols;

    if (templateTableAvailable && !isEditMode) {
      if (!isTemplatePublishedForNewMission || (!hasFormTemplate && !hasGridTemplate)) {
        alert('미션 템플릿 설계 후 배포를 완료해야 미션을 등록할 수 있습니다.');
        return;
      }
    }

    const editingMission = isEditMode ? missions.find(m => m.id === editingMissionId) : null;
    const existingTemplateSchema = editingMission
      ? missionTemplates[editingMission.id]?.schema_json ||
        parseMissionDescriptionInlineTemplate(editingMission.description_raw || editingMission.description).inlineTemplate
      : null;

    const draftTemplateSchema: MissionTemplate['schema_json'] | null =
      (hasFormTemplate || hasGridTemplate)
        ? newTemplateMode === 'grid'
          ? {
              mode: 'grid' as TemplateMode,
              fields: [] as MissionTemplateField[],
              grid: {
                title: newGridTitle || newMission.title,
                rowCount: newGridRows,
                colCount: newGridCols,
                rowHeaders: newGridRowHeaders,
                colHeaders: newGridColHeaders,
                successThreshold: newGridSuccessThreshold,
              },
            }
          : {
              mode: 'form' as TemplateMode,
              fields: newMissionTemplateFields,
            }
        : null;

    // mission_templates 테이블 유무와 무관하게, 설계된 템플릿은 미션 본문에 함께 보존한다.
    const schemaJsonForMission: MissionTemplate['schema_json'] | null = draftTemplateSchema || existingTemplateSchema;

    const normalizedAssignTo = assignTo === UNASSIGNED_LABEL ? UNASSIGNED_CODE : assignTo;
    let uploadedAttachments: AttachmentMeta[] = [];

    if (missionFiles && missionFiles.length > 0) {
      try {
        await ensureMissionBucket();
      } catch (err) {
        console.error('버킷 확인 오류:', err);
        alert('스토리지 버킷 확인 오류가 발생했습니다. 콘솔을 확인하세요.');
        return;
      }

      try {
        uploadedAttachments = await uploadMissionFiles(missionFiles);
      } catch (uploadError: any) {
        console.error('파일 업로드 실패:', uploadError);
        alert('파일 업로드 중 오류가 발생했습니다. 콘솔을 확인하세요: ' + (uploadError?.message || uploadError));
        return;
      }
    }

    let targetMissionId: number | null = null;

    if (isEditMode && editingMissionId !== null) {
      const mergedAttachments = [...(editingMission?.attachments || []), ...uploadedAttachments];
      const updatePayload = {
        title: newMission.title,
        description: buildMissionDescriptionWithInlineTemplate(newMission.description, schemaJsonForMission),
        category,
        subcategory,
        assigned_to: normalizedAssignTo,
        attachments: mergedAttachments,
      };

      const { error: updateError } = await supabase
        .from('missions')
        .update(updatePayload)
        .eq('id', editingMissionId);

      if (updateError) {
        console.error('미션 수정 실패:', updateError);
        alert('미션 수정 실패: ' + (updateError?.message || JSON.stringify(updateError)));
        return;
      }

      targetMissionId = editingMissionId;
    } else {
      const mission: any = {
        title: newMission.title,
        description: buildMissionDescriptionWithInlineTemplate(newMission.description, schemaJsonForMission),
        category,
        subcategory,
        created_by: currentCoach,
        assigned_to: normalizedAssignTo,
        attachments: uploadedAttachments,
        inserted_at: new Date().toISOString()
      };

      if (newMission.id.trim()) {
        mission.id = Number(newMission.id);
      } else {
        // DB에 id 기본값이 없을 때를 대비해 클라이언트에서 id를 채워넣기.
        try {
          const { data: maxIdData, error: maxIdError } = await supabase
            .from('missions')
            .select('id')
            .order('id', { ascending: false })
            .limit(1);

          if (maxIdError) {
            console.warn('max id 조회 실패, fallback으로 timestamp id 사용:', maxIdError);
            mission.id = Math.floor(Date.now() / 1000);
          } else {
            const nextId = (maxIdData?.[0]?.id ?? 0) + 1;
            mission.id = nextId;
          }
        } catch (e) {
          console.warn('max id 조회 도중 예외, timestamp id 사용:', e);
          mission.id = Math.floor(Date.now() / 1000);
        }
      }

      if (!mission.id) {
        // 혹시라도 위에서 실패하면 1000 기반 id 추가로 보장
        mission.id = Math.floor(Date.now() / 1000);
      }

      const { data, error } = await supabase.from('missions').insert([mission]).select();
      if (error) {
        console.error('미션 등록 실패:', error);
        alert('미션 등록 실패: ' + (error?.message || JSON.stringify(error)));
        return;
      }

      targetMissionId = data?.[0]?.id ?? mission.id;
    }

    if (targetMissionId && schemaJsonForMission && isTemplatePublishedForNewMission) {
      await publishMissionTemplate(targetMissionId, schemaJsonForMission);
      setMissionTemplates(prev => ({
        ...prev,
        [targetMissionId as number]: {
          mission_id: targetMissionId as number,
          version: (prev[targetMissionId as number]?.version ?? 0) + 1,
          status: 'published',
          schema_json: schemaJsonForMission,
        }
      }));
    }

    const successMessage = isEditMode ? '미션이 수정되었습니다.' : '미션이 등록되었습니다.';
    alert(successMessage);
    resetMissionEditor();
    loadMissions();
  };

  const uploadMissionFiles = async (files: File[]) => {
    if (files.length === 0) return [];

    await ensureMissionBucket();

    const attachments: { name: string; url: string; path: string; bucket?: string }[] = [];

    for (let idx = 0; idx < files.length && idx < 3; idx++) {
      const file = files[idx];
      const randomId = Math.random().toString(36).slice(2, 10);
      const timestamp = Date.now();
      const sanitizedName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const filePath = `mission_${timestamp}_${randomId}_${idx}_${sanitizedName}`;

      const bucketCandidates = [storageBucket, 'attachments', 'mission-files'];
      let uploadResult: any = { error: null };
      let usedBucket = storageBucket;

      for (const bucket of bucketCandidates) {
        if (!bucket) continue;
        try {
          uploadResult = await supabase.storage
            .from(bucket)
            .upload(filePath, file, { cacheControl: '3600', upsert: false });
          if (!uploadResult.error) {
            usedBucket = bucket;
            if (bucket !== storageBucket) {
              setStorageBucket(bucket);
            }
            break;
          } else {
            console.warn(`파일 업로드 실패 (${bucket}):`, uploadResult.error);
          }
        } catch (err) {
          console.warn(`파일 업로드 예외 (${bucket}):`, err);
          uploadResult = { error: err };
        }
      }

      if (uploadResult.error) {
        console.error('파일 업로드 실패: 모든 버킷 실패', uploadResult.error);
        throw uploadResult.error;
      }

      const { data: publicUrlData } = supabase.storage.from(usedBucket).getPublicUrl(filePath);
      if (!publicUrlData?.publicUrl) {
        console.error('공개 URL 생성 실패:', publicUrlData);
        throw new Error('공개 URL 생성에 실패했습니다.');
      }

      attachments.push({ name: file.name, url: publicUrlData.publicUrl, path: filePath, bucket: usedBucket });
    }

    return attachments;
  };

  const saveMissionDraft = async (
    missionId: number,
    options?: { includeFiles?: boolean; silent?: boolean }
  ) => {
    if (!currentPlayer) return;

    const includeFiles = options?.includeFiles === true;
    const silent = options?.silent === true;
    const note = (playerMissionNotes[missionId] || '').trim();
    const templateValues = playerTemplateValues[missionId] || {};
    const hasTemplateValues = Object.values(templateValues).some(value => `${value ?? ''}`.trim() !== '');
    const draftPayloadNote = buildMissionDraftPayload(missionId, note || '임시 저장');

    if (!note && !hasTemplateValues) {
      if (!silent) {
        alert('임시 저장할 내용이 없습니다.');
      }
      return;
    }

    setDraftSaveStatus(prev => ({ ...prev, [missionId]: '임시 저장 중...' }));

    try {
      const storageKey = getMissionDraftStorageKey(currentPlayer, missionId);
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(storageKey, draftPayloadNote);
      }
    } catch (e: any) {
      console.warn('로컬 임시 저장 실패:', e);
      setDraftSaveStatus(prev => ({ ...prev, [missionId]: '임시 저장 실패' }));
      if (!silent) {
        alert('임시 저장 실패: 브라우저 저장소를 확인하세요.');
      }
      return;
    }

    lastSavedDraftNoteRef.current[missionId] = note;
    lastSavedDraftPayloadRef.current[missionId] = draftPayloadNote;
    setDraftSaveStatus(prev => ({ ...prev, [missionId]: `임시 저장됨 (${new Date().toLocaleTimeString()})` }));

    if (!silent) {
      const fileHint = includeFiles ? ' 파일은 완료 제출 시 업로드됩니다.' : '';
      alert(`임시 저장되었습니다. 언제든 이어서 입력할 수 있습니다.${fileHint}`);
    }
  };

  useEffect(() => {
    if (isCoach || !currentPlayer || !selectedPlayerMissionId) return;

    const missionId = selectedPlayerMissionId;
    const isCompleted = selectedPlayerMissionStatus === 'completed';
    if (isCompleted) return;

    let cancelled = false;
    const loadDraft = async () => {
      if (cancelled) return;

      try {
        const storageKey = getMissionDraftStorageKey(currentPlayer, missionId);
        const rawDraft = typeof window !== 'undefined' ? window.localStorage.getItem(storageKey) : null;

        if (!rawDraft) {
          setDraftSaveStatus(prev => ({ ...prev, [missionId]: '로컬 임시저장 없음' }));
          return;
        }

        const parsed = parseMissionDraftPayload(rawDraft);
        setPlayerMissionNotes(prev => ({ ...prev, [missionId]: parsed.noteText || '' }));
        setPlayerTemplateValues(prev => ({ ...prev, [missionId]: parsed.templateValues || {} }));
        lastSavedDraftNoteRef.current[missionId] = (parsed.noteText || '').trim();
        lastSavedDraftPayloadRef.current[missionId] = rawDraft;
        setDraftSaveStatus(prev => ({ ...prev, [missionId]: '로컬 임시저장 불러옴' }));
      } catch (e: any) {
        console.warn('로컬 임시저장 불러오기 실패:', e);
      }
    };

    loadDraft();

    return () => {
      cancelled = true;
    };
  }, [selectedPlayerMissionId, currentPlayer, isCoach, selectedPlayerMissionStatus]);

  useEffect(() => {
    if (isCoach || !currentPlayer || !selectedPlayerMissionId) return;

    const missionId = selectedPlayerMissionId;
    const isCompleted = selectedPlayerMissionStatus === 'completed';
    if (isCompleted) return;

    const note = (playerMissionNotes[missionId] || '').trim();
    const templateValues = playerTemplateValues[missionId] || {};
    const hasTemplateValues = Object.values(templateValues).some(value => `${value ?? ''}`.trim() !== '');
    if (!note && !hasTemplateValues) return;

    const payloadSnapshot = buildMissionDraftPayload(missionId, note || '임시 저장');
    if (lastSavedDraftPayloadRef.current[missionId] === payloadSnapshot) return;

    setDraftSaveStatus(prev => ({ ...prev, [missionId]: '자동 저장 대기...' }));
    const timer = window.setTimeout(() => {
      saveMissionDraft(missionId, { includeFiles: false, silent: true });
    }, 1200);

    return () => {
      window.clearTimeout(timer);
    };
  }, [playerMissionNotes, playerTemplateValues, selectedPlayerMissionId, currentPlayer, isCoach, selectedPlayerMissionStatus]);

  const handleSendPlayerComment = async (missionId: number) => {
    if (!currentPlayer) {
      alert('선수로 로그인된 상태여야 합니다.');
      return;
    }

    const note = playerMissionNotes[missionId]?.trim();
    if (!note) {
      alert('메시지를 입력해주세요.');
      return;
    }

    const { data, error } = await supabase
      .from('mission_logs')
      .insert([
        {
          mission_id: missionId,
          player_id: currentPlayer,
          status: 'pending',
          note,
          coach_feedback: null
        }
      ])
      .select();

    if (error || !data) {
      alert('코멘트 전송 실패: ' + error?.message);
      return;
    }

    setPlayerMissionNotes(prev => ({ ...prev, [missionId]: '' }));
    loadMissionLogs();
    alert('코멘트가 전송되었습니다.');
  };

  const handleCompleteMission = async (missionId: number) => {
    if (!currentPlayer) {
      alert('선수로 로그인된 상태여야 합니다.');
      return;
    }

    if (latestMissionStatusById[missionId] === 'completed') {
      alert('이미 완료 제출된 미션입니다.');
      return;
    }

    const note = playerMissionNotes[missionId]?.trim() || '';
    const template = missionTemplates[missionId];
    const templateValues = playerTemplateValues[missionId] || {};
    const templateMode = template?.schema_json?.mode || 'form';
    const requiredFields = template?.schema_json?.fields?.filter(field => field.required) || [];
    const missingRequired = requiredFields.filter(field => !(templateValues[field.key] || '').toString().trim());

    if (templateMode === 'grid' && template?.schema_json?.grid) {
      const grid = template.schema_json.grid;
      const missingCells: string[] = [];
      for (let r = 0; r < grid.rowCount; r++) {
        for (let c = 0; c < grid.colCount; c++) {
          const cellKey = `cell_r${r}_c${c}`;
          if (!(templateValues[cellKey] || '').toString().trim()) {
            missingCells.push(`${grid.rowHeaders[r] || `행${r + 1}`} / ${grid.colHeaders[c] || `열${c + 1}`}`);
          }
        }
      }
      if (missingCells.length > 0) {
        alert(`빈칸 입력이 남아 있습니다. 예: ${missingCells.slice(0, 3).join(', ')}${missingCells.length > 3 ? ' ...' : ''}`);
        return;
      }
    }

    if (missingRequired.length > 0) {
      alert(`필수 입력 항목이 누락되었습니다: ${missingRequired.map(field => field.label).join(', ')}`);
      return;
    }

    if (!note && requiredFields.length === 0) {
      alert('미션 결과 내용을 입력해주세요.');
      return;
    }
    const files = playerMissionFiles[missionId] || [];
    const draftAttachments = playerDraftAttachments[missionId] || [];

    let attachments: AttachmentMeta[] = [];
    try {
      attachments = await uploadMissionFiles(files);
    } catch (uploadError: any) {
      alert('첨부파일 업로드 실패: ' + (uploadError?.message || uploadError));
      return;
    }

    const mergedCompletionAttachments = Array.from(
      new Map([...draftAttachments, ...attachments].map(file => [file.path, file])).values()
    );

    const mission = missions.find(m => m.id === missionId);
    if (mission && mergedCompletionAttachments.length > 0) {
      const merged = Array.from(
        new Map([...(mission.attachments || []), ...mergedCompletionAttachments].map(file => [file.path, file])).values()
      );
      const { error: updateError } = await supabase
        .from('missions')
        .update({ attachments: merged })
        .eq('id', missionId);
      if (updateError) {
        console.error('미션 첨부 업데이트 실패:', updateError);
      }
    }

    const completedPayloadBase = {
      mission_id: missionId,
      player_id: currentPlayer,
      status: 'completed' as const,
      note: buildMissionDraftPayload(missionId, note || '완료'),
      coach_feedback: null,
    };

    let submitError: any = null;
    let submitted = false;

    if (missionLogAttachmentsAvailableRef.current !== false) {
      const withAttachments = await supabase
        .from('mission_logs')
        .insert([
          {
            ...completedPayloadBase,
            attachments: mergedCompletionAttachments,
          }
        ])
        .select();

      if (!withAttachments.error && withAttachments.data) {
        missionLogAttachmentsAvailableRef.current = true;
        submitted = true;
      } else if (withAttachments.error && isMissingMissionLogAttachmentsColumnError(withAttachments.error)) {
        missionLogAttachmentsAvailableRef.current = false;
      } else {
        submitError = withAttachments.error;
      }
    }

    if (!submitted) {
      const fallback = await supabase
        .from('mission_logs')
        .insert([completedPayloadBase])
        .select();

      if (fallback.error || !fallback.data) {
        alert('미션 완료 제출 실패: ' + (fallback.error?.message || submitError?.message || 'unknown error'));
        return;
      }
    }

    setPlayerMissionNotes(prev => ({ ...prev, [missionId]: '' }));
    setPlayerMissionFiles(prev => ({ ...prev, [missionId]: [] }));
    setPlayerDraftAttachments(prev => ({ ...prev, [missionId]: [] }));
    setDraftSaveStatus(prev => ({ ...prev, [missionId]: '완료 제출됨' }));
    lastSavedDraftNoteRef.current[missionId] = '';
    lastSavedDraftPayloadRef.current[missionId] = '';
    try {
      const storageKey = getMissionDraftStorageKey(currentPlayer, missionId);
      if (typeof window !== 'undefined') {
        window.localStorage.removeItem(storageKey);
      }
    } catch (e) {
      console.warn('로컬 임시저장 삭제 실패:', e);
    }
    loadMissionLogs();
    loadMissions();
    alert('미션이 완료 제출되었습니다.');
  };

  const handlePlayerReply = async (logId: number, missionId: number) => {
    if (!currentPlayer) {
      alert('선수로 로그인된 상태여야 합니다.');
      return;
    }

    const replyText = playerReply[logId]?.trim();
    if (!replyText) {
      alert('답장을 입력해주세요.');
      return;
    }

    const { data, error } = await supabase
      .from('mission_logs')
      .insert([
        {
          mission_id: missionId,
          player_id: currentPlayer,
          status: 'pending',
          note: replyText,
          coach_feedback: null
        }
      ])
      .select();

    if (error || !data) {
      alert('답장 전송 실패: ' + error?.message);
      return;
    }

    setPlayerReply(prev => ({ ...prev, [logId]: '' }));
    loadMissionLogs();
    alert('코치에게 의견을 전달했습니다.');
  };

  const handlePlayerMessage = async (missionId: number) => {
    if (!currentPlayer) {
      alert('선수로 로그인된 상태여야 합니다.');
      return;
    }

    const message = playerMissionChat[missionId]?.trim();
    if (!message) {
      alert('전송할 메시지를 입력하세요.');
      return;
    }

    const { data, error } = await supabase
      .from('mission_logs')
      .insert([
        {
          mission_id: missionId,
          player_id: currentPlayer,
          status: 'pending',
          note: message,
          coach_feedback: null
        }
      ])
      .select();

    if (error || !data) {
      alert('메시지 전송 실패: ' + error?.message);
      return;
    }

    setPlayerMissionChat(prev => ({ ...prev, [missionId]: '' }));
    loadMissionLogs();
    alert('코치에게 메시지를 전송했습니다.');
  };

  const handleMissionChatSend = async (missionId: number) => {
    if (!currentPlayer) {
      alert('선수로 로그인된 상태여야 합니다.');
      return;
    }

    const message = missionReply[missionId]?.trim();
    if (!message) {
      alert('전송할 메시지를 입력하세요.');
      return;
    }

    const { data, error } = await supabase
      .from('mission_logs')
      .insert([
        {
          mission_id: missionId,
          player_id: currentPlayer,
          status: 'pending',
          note: message,
          coach_feedback: null
        }
      ])
      .select();

    if (error || !data) {
      alert('코멘트 전송 실패: ' + error?.message);
      return;
    }

    setMissionReply(prev => ({ ...prev, [missionId]: '' }));
    loadMissionLogs();
    alert('미션에 대한 코멘트가 전송되었습니다.');
  };

  const handleVerifyPlayer = async (playerId: string) => {
    const newValue = !verifiedPlayers[playerId];

    const { error } = await supabase
      .from('users')
      .update({ verified: newValue })
      .eq('id', playerId);

    if (error) {
      console.error('선수 인증 상태 업데이트 실패:', error);
      alert('선수 인증 업데이트에 실패했습니다. 콘솔을 확인하세요.');
      return;
    }

    setVerifiedPlayers(prev => ({ ...prev, [playerId]: newValue }));
  };

  const handleDeleteMission = async (missionId: number) => {
    const confirmed = window.confirm('이 미션을 삭제하시겠습니까?');
    if (!confirmed) return;

    const mission = missions.find(m => m.id === missionId);

    const { data: logRows, error: logRowsError } = await supabase
      .from('mission_logs')
      .select('attachments')
      .eq('mission_id', missionId);

    if (logRowsError) {
      console.warn('미션 로그 첨부 조회 실패:', logRowsError.message);
    }

    const attachmentMap = new Map<string, AttachmentMeta>();
    (mission?.attachments || []).forEach(file => {
      if (file?.path) attachmentMap.set(`${file.bucket || ''}:${file.path}`, file as AttachmentMeta);
    });

    (logRows || []).forEach((row: any) => {
      const files = Array.isArray(row?.attachments) ? (row.attachments as AttachmentMeta[]) : [];
      files.forEach(file => {
        if (file?.path) attachmentMap.set(`${file.bucket || ''}:${file.path}`, file);
      });
    });

    for (const attachment of attachmentMap.values()) {
      const bucketCandidates = Array.from(new Set([
        attachment.bucket,
        storageBucket,
        'attachments',
        'mission-files',
      ].filter(Boolean) as string[]));

      let removed = false;
      for (const bucket of bucketCandidates) {
        const { error: removeError } = await supabase.storage.from(bucket).remove([attachment.path]);
        if (!removeError) {
          removed = true;
          break;
        }
      }

      if (!removed) {
        console.warn('첨부파일 삭제 실패(모든 버킷 시도):', attachment.path);
      }
    }

    // FK 제약으로 삭제가 막히지 않도록 자식 데이터를 먼저 삭제한다.
    if (!missionTemplateDisabledRef.current && templateTableAvailable && missionTemplateTableConfirmedRef.current) {
      const templateDelete = await supabase
        .from('mission_templates')
        .delete()
        .eq('mission_id', missionId);

      if (templateDelete.error) {
        if (isMissingMissionTemplateTableError(templateDelete.error)) {
          disableMissionTemplateFeature();
        } else {
          console.warn('미션 템플릿 삭제 오류:', templateDelete.error);
        }
      }
    }

    const logDelete = await supabase
      .from('mission_logs')
      .delete()
      .eq('mission_id', missionId);

    if (logDelete.error) {
      console.error('미션 로그 삭제 오류:', logDelete.error);
      alert('미션 삭제 실패: 연결된 로그 삭제 중 오류가 발생했습니다. ' + (logDelete.error.message || ''));
      return;
    }

    const { error } = await supabase
      .from('missions')
      .delete()
      .eq('id', missionId);

    if (error) {
      console.error('미션 삭제 오류:', error);
      alert('미션 삭제에 실패했습니다. ' + (error.message || ''));
      return;
    }

    setMissionTemplates(prev => {
      const next = { ...prev };
      delete next[missionId];
      return next;
    });
    if (selectedMissionId === missionId) {
      setSelectedMissionId(null);
    }
    loadMissions();
    loadMissionLogs();
  };

  const onOpenAssignModal = (mission: Mission) => {
    setAssignModalMission(mission);
    setAssignTarget('');
  };

  const getNextMissionId = async () => {
    try {
      const { data: maxIdData, error: maxIdError } = await supabase
        .from('missions')
        .select('id')
        .order('id', { ascending: false })
        .limit(1);

      if (maxIdError) {
        console.warn('max id 조회 실패, fallback으로 timestamp id 사용:', maxIdError);
        return Math.floor(Date.now() / 1000);
      }

      return (maxIdData?.[0]?.id ?? 0) + 1;
    } catch (e) {
      console.warn('max id 조회 중 예외, timestamp id 사용:', e);
      return Math.floor(Date.now() / 1000);
    }
  };

  const assignSelectedPlayer = async () => {
    if (!assignModalMission || !assignTarget) {
      alert('선수를 선택하세요.');
      return;
    }

    const isUnassignedMission =
      assignModalMission.assigned_to === UNASSIGNED_CODE ||
      assignModalMission.assigned_to === UNASSIGNED_LABEL;

    if (isUnassignedMission) {
      const nextId = await getNextMissionId();
      const newMission: any = {
        id: nextId,
        title: assignModalMission.title,
        description: assignModalMission.description_raw || assignModalMission.description,
        category: assignModalMission.category,
        subcategory: assignModalMission.subcategory,
        created_by: assignModalMission.created_by,
        assigned_to: assignTarget,
        attachments: assignModalMission.attachments || [],
        inserted_at: new Date().toISOString(),
      };

      const { error } = await supabase.from('missions').insert(newMission);
      if (error) {
        alert('미션 복사 및 선수 지정 실패: ' + error.message);
        console.error('미션 할당 오류:', error);
        return;
      }

      if (!missionTemplateDisabledRef.current && templateTableAvailable) {
        const templateLookup = await supabase
          .from('mission_templates')
          .select('version, status, schema_json')
          .eq('mission_id', assignModalMission.id)
          .eq('status', 'published')
          .order('version', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (templateLookup.error) {
          if (isMissingMissionTemplateTableError(templateLookup.error)) {
            disableMissionTemplateFeature();
          } else {
            console.warn('복제 대상 템플릿 조회 실패:', templateLookup.error.message);
          }
        } else if (templateLookup.data) {
          missionTemplateTableConfirmedRef.current = true;
          const copiedTemplate = await supabase.from('mission_templates').insert([
            {
              mission_id: nextId,
              version: 1,
              status: 'published',
              schema_json: templateLookup.data.schema_json,
            }
          ]);

          if (copiedTemplate.error) {
            if (isMissingMissionTemplateTableError(copiedTemplate.error)) {
              disableMissionTemplateFeature();
            } else {
              console.warn('미션 템플릿 복제 실패:', copiedTemplate.error.message);
            }
          } else {
            missionTemplateTableConfirmedRef.current = true;
          }
        }
      }

      alert('미정 미션을 새로운 선수 할당 미션으로 복사했습니다. 원본 미정 미션은 유지됩니다.');
      setAssignModalMission(null);
      loadMissions();
      return;
    }

    const { error } = await supabase
      .from('missions')
      .update({
        assigned_to: assignTarget
      })
      .eq('id', assignModalMission.id);

    if (error) {
      alert('선수 지정 실패: ' + error.message);
      console.error('선수 지정 오류:', error);
      return;
    }

    setAssignModalMission(null);
    loadMissions();
  };

  const handleDeleteAttachment = async (missionId: number, attachmentPath: string) => {
    const confirmed = window.confirm('첨부 파일을 삭제하시겠습니까?');
    if (!confirmed) return;

    const { error: storageError } = await supabase.storage.from(storageBucket).remove([attachmentPath]);
    if (storageError) {
      console.error('첨부파일 삭제 실패:', storageError);
      alert('첨부파일 삭제에 실패했습니다.');
      return;
    }

    const mission = missions.find(m => m.id === missionId);
    if (!mission) return;

    const newAttachments = (mission.attachments || []).filter(a => a.path !== attachmentPath);

    const { error: updateError } = await supabase
      .from('missions')
      .update({ attachments: newAttachments })
      .eq('id', missionId);

    if (updateError) {
      console.error('미션 첨부 삭제 후 갱신 실패:', updateError);
      alert('첨부 정보 갱신 중 오류가 발생했습니다.');
      return;
    }

    setMissions(prev => prev.map(m => (m.id === missionId ? { ...m, attachments: newAttachments } : m)));
    alert('첨부파일이 삭제되었습니다.');
  };

  const handleDeletePlayer = async (playerId: string) => {
    const confirmed = window.confirm('정말 이 선수를 삭제하시겠습니까?');
    if (!confirmed) return;

    // 선수 관련 미션 로그 삭제
    const { error: logError } = await supabase
      .from('mission_logs')
      .delete()
      .eq('player_id', playerId);

    if (logError) {
      console.error('선수 미션 로그 삭제 실패:', logError);
      alert('선수 미션 로그 삭제 중 오류가 발생했습니다. 콘솔을 확인하세요.');
      return;
    }

    // 선수 관련 미션 데이터 삭제 (선택적, 요청에 따라 포함)
    const { error: missionError } = await supabase
      .from('missions')
      .delete()
      .eq('assigned_to', playerId);

    if (missionError) {
      console.error('할당된 미션 삭제 실패:', missionError);
      alert('할당된 미션 삭제 중 오류가 발생했습니다. 콘솔을 확인하세요.');
      return;
    }

    const { error } = await supabase
      .from('users')
      .delete()
      .eq('id', playerId)
      .eq('role', 'player');

    if (error) {
      console.error('선수 삭제 실패:', error);
      alert('선수 삭제 중 오류가 발생했습니다. 콘솔을 확인하세요.');
      return;
    }

    setPlayers(prev => prev.filter(p => p.id !== playerId));
    const { [playerId]: _, ...nextVerified } = verifiedPlayers;
    setVerifiedPlayers(nextVerified);
    alert('선수가 삭제되었습니다. (관련 미션 로그/피드백 포함)');
  };

  const handleRequestPlayerAccount = async () => {
    if (!requestedUsername.trim()) {
      alert('회원 아이디를 입력해주세요.');
      return;
    }
    if (!requestedDisplayName.trim()) {
      alert('이름을 입력해주세요.');
      return;
    }
    if (!requestedPassword.trim()) {
      alert('비밀번호를 입력해주세요.');
      return;
    }

    let existing = null;

    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('username', requestedUsername)
      .maybeSingle();

    if (error) {
      if (error.code === 'PGRST406' || error.code === 'PGRST400') {
        // 테이블에 username/display_name 컬럼이 없을 수 있음.
        console.warn('username/display_name 필드 확인 필요:', error.message);
      } else {
        console.error('중복 조회 오류:', error);
        return alert('오류 발생, 재시도');
      }
    } else {
      existing = data;
    }

    if (existing) {
      return alert('이미 존재하는 아이디입니다');
    }

    const insertData: any = {
      role: 'player',
      username: requestedUsername,
      encrypted_password: requestedPassword,
      coach_code: 'woody62',
      verified: false
    };

    if (requestedDisplayName) {
      insertData.display_name = requestedDisplayName;
    }

    let insertError = null;

    const doInsert = async (payload: any) => {
      const { error } = await supabase
        .from('users')
        .insert([payload])
        .select('id');
      return error;
    };

    insertError = await doInsert(insertData);

    if (insertError && insertError.code === 'PGRST204' && insertError.message?.includes('display_name')) {
      // display_name 컬럼이 없는 테이블이라면 우회 - 사용자에게 알림
      console.warn('display_name 컬럼이 없음; display_name 없이 재등록 시도');
      delete insertData.display_name;
      insertError = await doInsert(insertData);
      if (!insertError) {
        alert('display_name 컬럼 없음으로 username 기반 계정 등록 처리되었습니다.');
      }
    }

    if (insertError) {
      console.error('계정 신청 실패:', insertError);
      if (insertError.code === 'PGRST400' || insertError.code === 'PGRST204') {
        alert('users 테이블 스키마를 업데이트하세요 (username, encrypted_password, verified, coach_code, display_name 컬럼 권장).');
      } else {
        alert('계정 신청에 실패했습니다. 콘솔을 확인하세요.');
      }
      return;
    }

    setRequestedUsername('');
    setRequestedPassword('');
    setRequestedDisplayName('');
    alert('신청이 접수되었습니다. 코치 인증 후 사용 가능합니다.');
    loadPlayers();
  };

  const handleSetPlayerPassword = async (playerId: string, password: string) => {
    if (!password.trim()) {
      alert('비밀번호를 입력해주세요.');
      return;
    }

    const { error } = await supabase
      .from('users')
      .update({ encrypted_password: password })
      .eq('id', playerId);

    if (error) {
      console.error('선수 비밀번호 등록 실패:', error);
      alert('비밀번호 설정에 실패했습니다. 콘솔을 확인하세요.');
      return;
    }

    alert('선수 비밀번호가 설정되었습니다.');
  };
  const handleCoachFeedback = async (logId: number) => {
    if (!coachFeedback[logId] || !coachFeedback[logId].trim()) {
      alert('피드백 내용을 입력해주세요.');
      return;
    }

    const { error } = await supabase
      .from('mission_logs')
      .update({ coach_feedback: coachFeedback[logId] })
      .eq('id', logId);

    if (error) {
      alert('피드백 저장 실패: ' + error.message);
      return;
    }

    setCoachFeedback(prev => ({ ...prev, [logId]: '' }));
    loadMissionLogs();
    alert('피드백이 저장되었습니다.');
  };

  if (!role) {
    return (
      <div style={{ padding: 20, maxWidth: 720, margin: '0 auto', fontFamily: 'sans-serif' }}>
        <style>{`
          :root { --background: linear-gradient(180deg, #eff5ff 0%, #f7fbff 100%); }
          body { background: var(--background); margin: 0; }
          button { color: #fff; border: none; border-radius: 10px; padding: 8px 14px; cursor: pointer; transition: all 0.2s ease; font-weight: 600; }
          button:not(.top-action-btn):not(.category-btn) { background: #3f97ff; }
          button:not(.top-action-btn):not(.category-btn):hover { background: #1f86ff; transform: translateY(-1px); }
          .top-action-btn, .grey-action { background: #ced4da; color: #333; }
          .top-action-btn:hover, .grey-action:hover { background: #adb5bd; }
          .category-btn { background: #20c997; color: #fff; }
          .category-btn.active { background: #17a2b8; }
          .category-btn:hover { background: #1ca085; }
          .content-block { background: #fff; border: 1px solid #e6e6e6; border-radius: 14px; padding: 14px; margin-bottom: 13px; }
          .content-block-alt { background: #f8fbff; border: 1px solid #dce7f8; border-radius: 14px; padding: 14px; margin-bottom: 13px; }
          .content-section { background: #f4f8ff; border: 1px solid #d9e6ff; border-radius: 14px; padding: 12px; margin-bottom: 12px; }
          h1 { margin: 0; font-size: clamp(1.6rem, 5vw, 2.2rem); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
          h3 { margin: 0; font-size: clamp(0.8rem, 3vw, 1rem); color: #6c757d; }
          .subtitle { color: #6c757d; font-size: 0.85rem; opacity: 0.8; margin-top: 4px; }
          .subcategory-controls { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
          .category-box { cursor: default; margin-right: 8px; font-size: 0.9rem; padding: 4px 8px; border-radius: 8px; background: #e5f7ff; border: 1px solid #cde8ff; }
          .mission-list-container { max-height: 280px; overflow-y: auto; border-radius: 12px; border: 1px solid #ddd; padding: 8px; background: #fff; }
          input, textarea { border: 1px solid #ccc; border-radius: 8px; }
        `}</style>
        <div className="content-block" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, textAlign: 'center' }}>
          <h1 style={{ margin: 0, fontSize: 'clamp(1.4rem, 5vw, 1.8rem)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            SY_GPMP
          </h1>
          <div className="subtitle">ver26.3.1</div>
        </div>
        <p>코치 / 선수로 로그인해 주세요.</p>
        <div style={{ margin: '12px 0' }}>
          <input
            style={{ width: 'calc(100% - 12px)', padding: 8, marginBottom: 8 }}
            placeholder="아이디(코치코드 또는 선수아이디)"
            value={loginId}
            onChange={e => setLoginId(e.target.value)}
          />
          <input
            type="password"
            style={{ width: 'calc(100% - 12px)', padding: 8 }}
            placeholder="비밀번호"
            value={loginPassword}
            onChange={e => setLoginPassword(e.target.value)}
          />
          <button style={{ display: 'block', marginTop: 8 }} onClick={handleLogin}>
            로그인
          </button>
        </div>

        <div style={{ marginTop: 20, padding: 12, border: '1px solid #ddd', borderRadius: 4 }}>
          <h4>선수 계정 신청</h4>
          <input
            style={{ width: '100%', marginBottom: 8, padding: 8 }}
            placeholder="신청할 아이디"
            value={requestedUsername}
            onChange={e => setRequestedUsername(e.target.value)}
          />
          <input
            style={{ width: '100%', marginBottom: 8, padding: 8 }}
            placeholder="선수 이름 (예: 홍길동)"
            value={requestedDisplayName}
            onChange={e => setRequestedDisplayName(e.target.value)}
          />
          <input
            type="password"
            style={{ width: '100%', marginBottom: 8, padding: 8 }}
            placeholder="신청할 비밀번호"
            value={requestedPassword}
            onChange={e => setRequestedPassword(e.target.value)}
          />
          <button onClick={handleRequestPlayerAccount}>계정 신청</button>
          <p style={{ marginTop: 8, color: '#555', fontSize: 14 }}>
            신청 후 코치 인증을 받으면 사용 가능합니다.
          </p>
        </div>

      </div>
    );
  }

  const showVerificationPanelWithCoach = isCoach && currentCoach === 'woody62';

  const formatTimeDistance = (dateString?: string) => {
    if (!dateString) return '';
    const diff = Date.now() - new Date(dateString).getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return '방금';
    if (minutes < 60) return `${minutes}분 전`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}시간 전`;
    const days = Math.floor(hours / 24);
    return `${days}일 전`;
  };

  const markMissionViewed = (missionId: number) => {
    setViewedMissionIds(prev => (prev.includes(missionId) ? prev : [...prev, missionId]));
  };

  // existing code should continue now

  const getPlayerLabel = (playerId: string) => {
    if (playerId === 'all') return '전체';
    const player = players.find(p => p.id === playerId);
    if (!player) return playerId;

    const name = player.display_name || player.username || player.id;
    const alias = player.username ? player.username : '';

    if (player.display_name && player.username) {
      return `${player.display_name}(${player.username})`;
    }
    if (player.display_name) {
      return player.display_name;
    }
    if (player.username) {
      return player.username;
    }
    return player.id;
  };

  const openShotConsistencyTool = async () => {
    const localUrl = 'file:///C:/workspace/scatter_consistency_master_ui.html';
    const basePath = window.location.pathname.replace(/\/[^/]*$/, '');
    const normalizedBase = basePath.endsWith('/') ? basePath : `${basePath}/`;
    const currentBaseUrl = `${window.location.origin}${normalizedBase}scatter_consistency_master_ui.html`;
    const missionProjectBaseUrl = `${window.location.origin}/Mission-project/scatter_consistency_master_ui.html`;

    const candidates = [currentBaseUrl, missionProjectBaseUrl, localUrl];

    for (const candidate of candidates) {
      if (candidate.startsWith('file://')) {
        // file://는 fetch로 접근 불가할 수 있으므로 iframe 모드에서도 사용 어려움
        continue;
      }

      try {
        const res = await fetch(candidate, { method: 'GET' });
        if (!res.ok) continue;
        const text = await res.text();
        const isAppIndex = text.includes('<div id="root"></div>') && text.includes('src="./src/main.tsx"');
        if (isAppIndex) continue;

        setShotConsistencyUrl(candidate);
        setShotPanelMode('window');
        setShowShotConsistencyPanel(true);
        return;
      } catch (error) {
        continue;
      }
    }

    alert('샷 일관성 도구를 찾을 수 없습니다. public 폴더에 scatter_consistency_master_ui.html을 두고 테스트하세요. (예: http://localhost:5174/Mission-project/scatter_consistency_master_ui.html)');
  };

  return (
    <div style={{
      minHeight: '100vh',
      background: '#f2f6ef',
      padding: '12px 8px',
      display: 'flex',
      justifyContent: 'center',
      boxSizing: 'border-box',
    }}>
      {showShotConsistencyPanel && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          background: 'rgba(0,0,0,0.65)',
          zIndex: 9999,
          display: 'flex',
          flexDirection: 'column',
        }}>
          <div style={{
            borderBottom: '1px solid #ccc',
            background: '#fff',
            padding: '10px 12px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <strong style={{ fontSize: 14, marginRight: 8 }}>샷 일관성 도구</strong>
              <button onClick={() => setShotPanelMode(prev => (prev === 'fullscreen' ? 'window' : 'fullscreen'))} style={{ padding: '4px 8px' }}>
                {shotPanelMode === 'fullscreen' ? '창모드' : '전체화면'}
              </button>
            </div>
            <button onClick={() => setShowShotConsistencyPanel(false)} style={{ padding: '6px 10px' }}>
              닫기
            </button>
          </div>
          <div style={{
            background: '#fff',
            flex: 1,
            overflow: 'auto',
            padding: 10,
            boxSizing: 'border-box',
            width: shotPanelMode === 'fullscreen' ? '100%' : '80%',
            height: shotPanelMode === 'fullscreen' ? '100%' : '80%',
            margin: shotPanelMode === 'fullscreen' ? 0 : 'auto',
            boxShadow: shotPanelMode === 'fullscreen' ? 'none' : '0 0 16px rgba(0,0,0,0.2)',
            borderRadius: shotPanelMode === 'fullscreen' ? 0 : 12,
          }}>
            <div style={{ marginBottom: 8, fontSize: 12, color: '#555' }}>
              * 외부 도구를 iframe으로 로드합니다.
            </div>
            <iframe
              src={shotConsistencyUrl}
              style={{ width: '100%', height: '100%', border: 0 }}
              title="샷 일관성 도구"
            />
          </div>
        </div>
      )}
      <style>{`
        :root { --background: linear-gradient(180deg, #eff5ff 0%, #f7fbff 100%); }
        body { background: var(--background); }
        button { color: #fff; border: none; border-radius: 8px; padding: 8px 12px; cursor: pointer; transition: all 0.2s ease; font-weight: 600; }
        button:not(.top-action-btn):not(.category-btn) { background: #3f97ff; }
        button:not(.top-action-btn):not(.category-btn):hover { background: #1f86ff; transform: translateY(-1px); }
        .top-action-btn, .grey-action { background: #ced4da; color: #333; }
        .top-action-btn:hover, .grey-action:hover { background: #adb5bd; }
        .category-btn { background: #20c997; color: #fff; }
        .category-btn.active { background: #17a2b8; }
        .category-btn:hover { background: #1ca085; }
        .content-block { background: #fff; border: 1px solid #e6e6e6; border-radius: 14px; padding: 14px; margin-bottom: 13px; }
        .content-block-alt { background: #f8fbff; border: 1px solid #dce7f8; border-radius: 14px; padding: 14px; margin-bottom: 13px; }
        .content-section { background: #f4f8ff; border: 1px solid #d9e6ff; border-radius: 14px; padding: 12px; margin-bottom: 12px; }
        h1 { margin: 0; font-size: clamp(1.4rem, 6vw, 1.8rem); }
        h3 { margin: 0; }
        .subtitle { color: #6c757d; font-size: 0.85rem; opacity: 0.7; margin-top: 4px; }
        .subcategory-controls { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
        input, textarea { border: 1px solid #ccc; border-radius: 8px; }
      `}</style>
      <div style={{
        width: '100%',
        maxWidth: 480,
        background: '#fffef8',
        borderRadius: 16,
        boxShadow: '0 8px 24px rgba(0,0,0,0.08)',
        padding: 16,
        boxSizing: 'border-box',
        fontFamily: 'Noto Sans KR, Arial, sans-serif',
      }}>
        <div style={{
          background: '#fff9d6',
          border: '1px solid #f0e6ae',
          borderRadius: 12,
          padding: '10px 14px',
          margin: '0 0 16px 0',
          boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.08)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          textAlign: 'center'
        }}>
          <h1 style={{ margin: 0, fontSize: '1.5rem', color: '#4b4b4b', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            SY-GPMP
          </h1>
          <div className="subtitle">ver26.3.1</div>
        </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 8 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="top-action-btn"
            onClick={() => {
              setRole(null);
              setCurrentCoach(null);
              setCurrentPlayer(null);
              setLoginId('');
              setLoginPassword('');
              resetMissionEditor();
            }}
          >
            로그아웃
          </button>

          <button
            className="top-action-btn"
            onClick={() => {
              if (window.history.length > 1) {
                window.history.back();
              } else {
                window.location.href = '/';
              }
            }}
          >
            이전 페이지
          </button>
        </div>

        {showVerificationPanelWithCoach && (
          <button
            style={{ background: '#ff9800', color: '#fff', border: 'none', borderRadius: 4, padding: '8px 12px', cursor: 'pointer' }}
            onClick={() => setShowVerificationPanel(prev => !prev)}
          >
            선수 인증 관리 {showVerificationPanel ? '닫기' : '열기'}
          </button>
        )}
      </div>

      <hr />

      {showVerificationPanelWithCoach && showVerificationPanel && (
        <div style={{ marginTop: 16, border: '1px solid #eee', borderRadius: 8, padding: 12, background: '#fafafa' }}>
          <h4 style={{ margin: '0 0 8px 0' }}>선수 인증 상태</h4>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 250, maxHeight: 280, overflowY: 'auto', border: '1px solid #ddd', borderRadius: 6, padding: 8 }}>
              <h5 style={{ margin: '8px 0' }}>인증 완료 ({Object.values(verifiedPlayers).filter(v => v).length})</h5>
              {players.filter(p => p.role === 'player' && verifiedPlayers[p.id]).map(player => (
                <div key={player.id} style={{ marginBottom: 8 }}>
                  <div>
                    <strong>이름:</strong> {player.display_name || '(이름 없음)'} {' '}
                    <strong>(ID:</strong> {player.username || player.id}{')'}
                  </div>
                  <div>
                    인증 상태: <strong>완료</strong>
                    <button style={{ marginLeft: 8, fontSize: '0.75rem', padding: '3px 7px', height: '26px', minWidth: 'auto' }} onClick={() => handleVerifyPlayer(player.id)}>
                      인증 취소
                    </button>
                    <button
                      style={{ marginLeft: 8, borderColor: '#d9534f', color: '#d9534f', fontSize: '0.75rem', padding: '3px 7px', height: '26px', minWidth: 'auto' }}
                      onClick={() => handleDeletePlayer(player.id)}
                    >
                      삭제
                    </button>
                  </div>
                </div>
              ))}
              {players.filter(p => p.role === 'player' && verifiedPlayers[p.id]).length === 0 && (
                <p style={{ margin: '6px 0', color: '#666' }}>인증 완료된 선수가 없습니다.</p>
              )}
            </div>

            <div style={{ flex: 1, minWidth: 250, maxHeight: 280, overflowY: 'auto', border: '1px solid #ddd', borderRadius: 6, padding: 8 }}>
              <h5 style={{ margin: '8px 0' }}>인증 대기 ({players.filter(p => p.role === 'player' && !verifiedPlayers[p.id]).length})</h5>
              {players.filter(p => p.role === 'player' && !verifiedPlayers[p.id]).map(player => (
                <div key={player.id} style={{ marginBottom: 8 }}>
                  <div>
                    <strong>이름:</strong> {player.display_name || '(이름 없음)'} {' '}
                    <strong>(ID:</strong> {player.username || player.id}{')'}
                  </div>
                  <div>
                    인증 상태: <strong>대기</strong>
                    <button style={{ marginLeft: 8 }} onClick={() => handleVerifyPlayer(player.id)}>
                      인증 처리
                    </button>
                    <button
                      style={{ marginLeft: 8, borderColor: '#d9534f', color: '#d9534f' }}
                      onClick={() => handleDeletePlayer(player.id)}
                    >
                      삭제
                    </button>
                  </div>
                </div>
              ))}
              {players.filter(p => p.role === 'player' && !verifiedPlayers[p.id]).length === 0 && (
                <p style={{ margin: '6px 0', color: '#666' }}>인증 대기 중인 선수가 없습니다.</p>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="content-block" style={{ padding: '16px 16px 10px 16px' }}>
        <h3 style={{ marginBottom: 10, fontSize: '1.05rem' }}>미션 카테고리</h3>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button disabled={category === 'technical'} onClick={() => {setCategory('technical'); setSubcategory(subcategories.technical[0].key); setShowSubcategoryDropdown(false);}}>
            ⚙️ 테크니컬 미션
          </button>
          <button disabled={category === 'game'} onClick={() => {setCategory('game'); setSubcategory(subcategories.game[0].key); setShowSubcategoryDropdown(false);}}>
            🏌️ 실전 미션
          </button>
        </div>
      </div>

      {category && (
        <div style={{ marginTop: 10 }}>
          <div
            style={{
              border: '1px solid #cde8ff',
              borderRadius: 8,
              padding: '10px 12px',
              cursor: 'pointer',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              background: '#fff'
            }}
            onClick={() => setShowSubcategoryDropdown(prev => !prev)}
          >
            <span style={{ color: '#333', fontWeight: 600 }}>
              {subcategory ? subcategories[category].find(s => s.key === subcategory)?.label : '서브카테고리 선택'}
            </span>
            <span style={{ transform: showSubcategoryDropdown ? 'rotate(180deg)' : 'rotate(0deg)', transition: '0.2s' }}>▾</span>
          </div>

          {showSubcategoryDropdown && (
            <div style={{ border: '1px solid #dee2e6', borderRadius: 8, marginTop: 4, background: '#fff', boxShadow: '0 2px 6px rgba(0,0,0,0.12)' }}>
              {subcategories[category].map(item => (
                <div
                  key={item.key}
                  style={{
                    padding: '10px 12px',
                    borderBottom: '1px solid #f1f3f5',
                    cursor: 'pointer',
                    background: subcategory === item.key ? '#e9f4ff' : '#fff'
                  }}
                  onClick={() => {
                    setSubcategory(item.key);
                    setShowSubcategoryDropdown(false);
                    if (item.key === 'shot_consistency') {
                      openShotConsistencyTool();
                    }
                  }}
                >
                  {item.label}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {isCoach && (
        <div style={{ marginTop: 20 }}>
          <h3>미션 리스트 (코치 모드)</h3>

          <div style={{ marginBottom: 12 }}>
            <span style={{ color: '#666' }}>
              {selectedMissionId ? `선택된 미션 #${selectedMissionId}` : '미션을 선택하세요.'}
            </span>
          </div>

          <div style={{ marginBottom: 16 }}>
            {unassignedMissions.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <h4 style={{ margin: '0 0 8px 0' }}>미션 저장소</h4>
                <div style={{ maxHeight: 160, overflowY: 'auto', overflowX: 'hidden', border: '1px solid #ddd', borderRadius: 6 }}>
                  <table style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', fontSize: '0.92rem' }}>
                    <colgroup>
                      <col style={{ width: '14.2857%' }} />
                      <col style={{ width: '42.8571%' }} />
                      <col style={{ width: '14.2857%' }} />
                      <col style={{ width: '28.5714%' }} />
                    </colgroup>
                    <thead>
                      <tr style={{ position: 'sticky', top: 0, background: '#fff', zIndex: 1 }}>
                        <th style={{ textAlign: 'left', padding: '7px 8px', borderBottom: '1px solid #ccc' }}>ID</th>
                        <th style={{ textAlign: 'left', padding: '7px 8px', borderBottom: '1px solid #ccc' }}>제목</th>
                        <th style={{ textAlign: 'left', padding: '7px 8px', borderBottom: '1px solid #ccc' }}>할당</th>
                        <th style={{ textAlign: 'left', padding: '7px 8px', borderBottom: '1px solid #ccc' }}>등록일</th>
                      </tr>
                    </thead>
                    <tbody>
                      {unassignedMissions.map(m => (
                        <tr
                          key={`unassigned-${m.id}`}
                          onClick={() => setSelectedMissionId(m.id)}
                          style={{
                            cursor: 'pointer',
                            background: selectedMissionId === m.id ? '#eef6ff' : '#fff',
                            borderBottom: '1px solid #f0f0f0'
                          }}
                        >
                          <td style={{ padding: '6px 8px', width: '14.2857%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>#{m.id}</td>
                          <td style={{ padding: '6px 8px', width: '42.8571%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.title}</td>
                          <td style={{ padding: '6px 8px', width: '14.2857%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{UNASSIGNED_LABEL}</td>
                          <td style={{ padding: '6px 8px', width: '28.5714%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.inserted_at ? new Date(m.inserted_at).toLocaleString() : '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {assignedMissions.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <h4 style={{ margin: '0 0 8px 0' }}>지정된 미션</h4>
                <div style={{ maxHeight: 160, overflowY: 'auto', overflowX: 'hidden', border: '1px solid #ddd', borderRadius: 6 }}>
                  <table style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', fontSize: '0.92rem' }}>
                    <colgroup>
                      <col style={{ width: '14.2857%' }} />
                      <col style={{ width: '42.8571%' }} />
                      <col style={{ width: '14.2857%' }} />
                      <col style={{ width: '28.5714%' }} />
                    </colgroup>
                    <thead>
                      <tr style={{ position: 'sticky', top: 0, background: '#fff', zIndex: 1 }}>
                        <th style={{ textAlign: 'left', padding: '7px 8px', borderBottom: '1px solid #ccc' }}>ID</th>
                        <th style={{ textAlign: 'left', padding: '7px 8px', borderBottom: '1px solid #ccc' }}>제목</th>
                        <th style={{ textAlign: 'left', padding: '7px 8px', borderBottom: '1px solid #ccc' }}>할당</th>
                        <th style={{ textAlign: 'left', padding: '7px 8px', borderBottom: '1px solid #ccc' }}>등록일</th>
                      </tr>
                    </thead>
                    <tbody>
                      {assignedMissions.map(m => (
                        <tr
                          key={`assigned-${m.id}`}
                          onClick={() => setSelectedMissionId(m.id)}
                          style={{
                            cursor: 'pointer',
                            background: selectedMissionId === m.id ? '#eef6ff' : '#fff',
                            borderBottom: '1px solid #f0f0f0'
                          }}
                        >
                          <td style={{ padding: '6px 8px', width: '14.2857%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>#{m.id}</td>
                          <td style={{ padding: '6px 8px', width: '42.8571%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.title}</td>
                          <td style={{ padding: '6px 8px', width: '14.2857%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.assigned_to === 'all' ? '전체' : getPlayerLabel(m.assigned_to)}</td>
                          <td style={{ padding: '6px 8px', width: '28.5714%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.inserted_at ? new Date(m.inserted_at).toLocaleString() : '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {filteredMissions.length === 0 && (
              <div style={{ padding: 10, color: '#666' }}>현재 등록된 미션이 없습니다.</div>
            )}
          </div>

          {selectedMissionId === null ? (
            <p>목록에서 미션 제목을 클릭하면 상세 내용이 여기에 표시됩니다.</p>
          ) : visibleMissions.length === 0 ? (
            <p>선택된 미션을 찾을 수 없습니다.</p>
          ) : null}

          <div style={{ maxHeight: 400, overflowY: 'auto', paddingRight: 8, border: '1px solid #eee', borderRadius: 6 }}>
            <ul style={{ paddingLeft: 0, listStyle: 'none', margin: 0 }}>
              {visibleMissions.map(m => (
                <li
                  key={m.id}
                  style={{
                    marginBottom: 10,
                    padding: 12,
                    borderRadius: 8,
                    background: '#f8f9fa',
                    boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap' }}>
                    <div style={{ flex: 1, minWidth: '60%' }}>
                      <strong style={{ fontSize: 16 }}>{m.title}</strong>
                      <p style={{ margin: '6px 0' }}>{m.description}</p>
                      {m.attachments && m.attachments.length > 0 && (
                        <div style={{ marginBottom: 8 }}>
                          <strong>첨부:</strong>
                          <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
                            {m.attachments.map((file, idx) => (
                              <li key={idx} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <button
                                  type="button"
                                  style={{ fontSize: '0.8rem', padding: '4px 8px', background: '#f7f7f7', border: '1px solid #ccc', borderRadius: 6, cursor: 'pointer', color: '#1f2937', fontWeight: 600 }}
                                  onClick={async () => {
                                    await openAttachment(file);
                                  }}
                                >
                                  {file.name}
                                </button>
                                <button
                                  type="button"
                                  style={{ fontSize: '0.8rem', padding: '2px 6px' }}
                                  onClick={() => handleDeleteAttachment(m.id, file.path)}
                                >
                                  삭제
                                </button>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      <p style={{ color: '#666', margin: 0 }}>
                        ID: #{m.id} / 작성: {m.created_by} / 할당: {m.assigned_to === UNASSIGNED_CODE || m.assigned_to === UNASSIGNED_LABEL ? UNASSIGNED_LABEL : (m.assigned_name || getPlayerLabel(m.assigned_to))}
                      </p>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {m.subcategory === 'shot_consistency' && (
                        <button
                          style={{ fontSize: '0.8rem', padding: '4px 8px', background: '#28a745', color: '#fff' }}
                          onClick={openShotConsistencyTool}
                        >
                          샷 일관성 도구 실행
                        </button>
                      )}
                      <button
                        style={{ fontSize: '0.8rem', padding: '4px 8px', background: '#2563eb', color: '#fff' }}
                        onClick={() => loadMissionIntoEditor(m)}
                      >
                        불러와 수정
                      </button>
                      {(m.assigned_to === UNASSIGNED_CODE || m.assigned_to === UNASSIGNED_LABEL) ? (
                        <button
                          style={{ fontSize: '0.8rem', padding: '4px 8px' }}
                          onClick={() => onOpenAssignModal(m)}
                        >
                          선수 지정
                        </button>
                      ) : null}
                      <button
                        style={{
                          background: '#d9534f',
                          color: '#fff',
                          border: 'none',
                          borderRadius: 4,
                          padding: '6px 10px',
                          cursor: 'pointer',
                          marginTop: 6,
                        }}
                        onClick={() => handleDeleteMission(m.id)}
                      >
                        삭제
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {isCoach && (
        <div style={{ marginTop: 24, borderTop: '1px solid #eee', paddingTop: 12 }}>
          <h3>{editingMissionId !== null ? `미션 수정 #${editingMissionId}` : '미션 추가'}</h3>
          {editingMissionId !== null && (
            <p style={{ marginTop: -2, marginBottom: 8, color: '#475569', fontSize: '0.88rem' }}>
              저장소에서 불러온 미션을 수정 중입니다. 수정 저장 시 기존 미션이 업데이트됩니다.
            </p>
          )}
          <input
            style={{ width: '100%', marginBottom: 8, padding: 8 }}
            value={newMission.title}
            placeholder="미션 제목"
            onChange={e => setNewMission(s => ({ ...s, title: e.target.value }))}
          />
          <textarea
            style={{ width: '100%', marginBottom: 8, padding: 8 }}
            rows={3}
            value={newMission.description}
            placeholder="미션 설명"
            onChange={e => setNewMission(s => ({ ...s, description: e.target.value }))}
          />
          <div style={{ marginBottom: 8 }}>
            <label>할당 대상:&nbsp;</label>
            <select value={assignTo} onChange={e => setAssignTo(e.target.value)}>
              <option value="all">전체 선수</option>
              <option value={UNASSIGNED_CODE}>{UNASSIGNED_LABEL}</option>
              {players.map(p => (
                <option key={p.id} value={p.id}>
                  선수 {p.display_name || p.username || p.id}
                </option>
              ))}
            </select>
            <p style={{ margin: '4px 0 0', color: '#666', fontSize: '0.85rem' }}>
              {UNASSIGNED_LABEL} 선택 시 선수에게 미할당 상태로 저장됩니다. 이후 선수 지정 시 원본 {UNASSIGNED_LABEL} 미션은 유지되고 복제하여 할당됩니다.
            </p>
          </div>
          <div style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
              <label style={{ fontWeight: 600 }}>미션 입력 템플릿</label>
              <button
                type="button"
                onClick={() => setShowTemplateDesigner(true)}
                style={{ fontSize: '0.8rem', padding: '4px 8px', background: '#334155' }}
              >
                템플릿 설계
              </button>
            </div>
            <div style={{ fontSize: '0.82rem', color: '#475569', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 6, padding: '6px 8px' }}>
              상태: {isTemplatePublishedForNewMission ? '배포 완료' : '미배포'} / 모드: {newTemplateMode === 'form' ? '필드형' : '시트형'} / {newTemplateMode === 'form' ? `필드 ${newMissionTemplateFields.length}개` : `${newGridRows}행 x ${newGridCols}열`}
            </div>
          </div>

          <div style={{ marginBottom: 8 }}>
            <label>첨부 파일 (최대 3개):&nbsp;</label>
            <input
              type="file"
              accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.bmp,.gif"
              multiple
              onChange={e => {
                if (!e.target.files) return;
                const incoming = Array.from(e.target.files);
                setMissionFiles(prev => {
                  const nextFiles = [...prev, ...incoming];
                  if (nextFiles.length > 3) {
                    alert('파일은 최대 3개까지 첨부할 수 있습니다.');
                    return prev;
                  }
                  return nextFiles;
                });
              }}
            />
            <div style={{ marginTop: 6, fontSize: '0.85rem', color: '#1f2937', background: '#f3f4f6', border: '1px solid #d1d5db', borderRadius: 6, padding: '6px 8px', fontWeight: 600 }}>
              선택된 파일: {missionFiles.length > 0 ? missionFiles.map(f => f.name).join(', ') : '없음'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={handleAddMission}>{editingMissionId !== null ? '미션 수정 저장' : '미션 등록'}</button>
            {editingMissionId !== null && (
              <button type="button" className="grey-action" onClick={resetMissionEditor}>수정 취소</button>
            )}
          </div>
        </div>
      )}

      {isCoach && (
        <div style={{ marginTop: 24, borderTop: '1px solid #eee', paddingTop: 12 }}>
          <h3>코치 미션 로그 / 피드백 관리</h3>
          <div style={{ marginBottom: 12, border: '1px solid #d8e4ff', borderRadius: 8, padding: 10, background: '#f9fcff' }}>
            <strong>완료 로그 분석</strong>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
              <div style={{ minWidth: 140, padding: '8px 10px', border: '1px solid #e2e8f0', borderRadius: 6, background: '#fff' }}>
                <div style={{ fontSize: '0.78rem', color: '#64748b' }}>총 완료 제출</div>
                <div style={{ fontSize: '1rem', fontWeight: 700, color: '#0f172a' }}>{coachCompletedSummary.completedCount}건</div>
              </div>
              <div style={{ minWidth: 140, padding: '8px 10px', border: '1px solid #e2e8f0', borderRadius: 6, background: '#fff' }}>
                <div style={{ fontSize: '0.78rem', color: '#64748b' }}>완료 선수 수</div>
                <div style={{ fontSize: '1rem', fontWeight: 700, color: '#0f172a' }}>{coachCompletedSummary.uniquePlayerCount}명</div>
              </div>
              <div style={{ minWidth: 220, padding: '8px 10px', border: '1px solid #e2e8f0', borderRadius: 6, background: '#fff' }}>
                <div style={{ fontSize: '0.78rem', color: '#64748b' }}>최근 완료</div>
                <div style={{ fontSize: '0.92rem', fontWeight: 600, color: '#0f172a' }}>
                  {coachCompletedSummary.recentCompletedAt ? new Date(coachCompletedSummary.recentCompletedAt).toLocaleString() : '없음'}
                </div>
              </div>
            </div>

            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: '0.82rem', color: '#475569', marginBottom: 4 }}>미션별 완료 상위 5개</div>
              {coachCompletedSummary.missionRanking.length === 0 ? (
                <div style={{ fontSize: '0.85rem', color: '#94a3b8' }}>완료 로그가 아직 없습니다.</div>
              ) : (
                <div style={{ display: 'grid', gap: 6 }}>
                  {coachCompletedSummary.missionRanking.map(item => (
                    <div key={item.missionId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', border: '1px solid #e2e8f0', borderRadius: 6, background: '#fff', padding: '6px 8px' }}>
                      <span style={{ fontSize: '0.88rem', color: '#1f2937' }}>{item.title}</span>
                      <span style={{ fontSize: '0.82rem', fontWeight: 700, color: '#0f172a' }}>{item.count}건</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div style={{ maxHeight: 440, overflowY: 'auto', paddingRight: 6 }}>
            {missionLogs.map(log => (
              <div key={log.id} style={{ border: '1px dashed #666', marginBottom: 8, padding: 8 }}>
                <div>로그 ID: {log.id}</div>
                <div>미션 ID: {log.mission_id}</div>
                <div>선수: {getPlayerLabel(log.player_id)}</div>
                <div>상태: {log.status}</div>
                <div>선수코멘트: {getLogDisplayNote(log.note)}</div>
                {(() => {
                  const tableData = getTemplateTableRows(log.mission_id, log.note);
                  if (!tableData) {
                    return <div style={{ fontSize: '0.82rem', color: '#334155' }}>입력값 요약: {getTemplateValueSummary(log.mission_id, log.note)}</div>;
                  }

                  if (tableData.mode === 'grid') {
                    return (
                      <div style={{ marginTop: 6, border: '1px solid #dbe4f0', borderRadius: 6, padding: 8, background: '#fff' }}>
                        <div style={{ fontSize: '0.8rem', color: '#334155', marginBottom: 6, fontWeight: 600 }}>
                          입력 템플릿 시트: {tableData.title}
                        </div>
                        <div style={{ overflowX: 'auto' }}>
                          <table style={{ width: '100%', minWidth: 520, borderCollapse: 'collapse' }}>
                            <thead>
                              <tr>
                                <th style={{ border: '1px solid #dbe4f0', background: '#f1f5f9', padding: '4px 6px' }}>구분</th>
                                {tableData.headers.map((header, idx) => (
                                  <th key={`coach_header_${log.id}_${idx}`} style={{ border: '1px solid #dbe4f0', background: '#f1f5f9', padding: '4px 6px' }}>
                                    {header}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {tableData.rows.map((row, rIdx) => (
                                <tr key={`coach_row_${log.id}_${rIdx}`}>
                                  <td style={{ border: '1px solid #dbe4f0', background: '#f8fafc', padding: '4px 6px', fontWeight: 600 }}>{row.label}</td>
                                  {row.cells.map((cell, cIdx) => (
                                    <td key={`coach_cell_${log.id}_${rIdx}_${cIdx}`} style={{ border: '1px solid #dbe4f0', padding: '4px 6px', textAlign: 'center' }}>
                                      {cell || '-'}
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div style={{ marginTop: 6, border: '1px solid #dbe4f0', borderRadius: 6, padding: 8, background: '#fff' }}>
                      <div style={{ fontSize: '0.8rem', color: '#334155', marginBottom: 6, fontWeight: 600 }}>입력 템플릿 항목</div>
                      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <tbody>
                          {tableData.rows.map((row, idx) => (
                            <tr key={`coach_form_${log.id}_${idx}`}>
                              <td style={{ border: '1px solid #dbe4f0', background: '#f8fafc', padding: '4px 6px', width: '35%', fontWeight: 600 }}>{row.label}</td>
                              <td style={{ border: '1px solid #dbe4f0', padding: '4px 6px' }}>{row.value || '-'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  );
                })()}
                <div>코치: {log.coach_feedback || '없음'}</div>
                <textarea
                  value={coachFeedback[log.id] || ''}
                  onChange={e => setCoachFeedback(prev => ({ ...prev, [log.id]: e.target.value }))}
                  placeholder="코치 코멘트를 입력하세요"
                  style={{ width: '100%', minHeight: 60, marginTop: 8 }}
                />
                <button onClick={() => handleCoachFeedback(log.id)} style={{ marginTop: 8 }}>
                  전송
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {isCoach && showTemplateDesigner && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ width: '92%', maxWidth: 620, maxHeight: '85vh', overflowY: 'auto', background: '#fff', borderRadius: 10, padding: 16 }}>
            <h4 style={{ margin: '0 0 10px' }}>미션 템플릿 설계</h4>
            <div style={{ marginBottom: 10, border: '1px solid #e2e8f0', borderRadius: 8, padding: 10, background: '#f8fafc' }}>
              <div style={{ fontSize: '0.85rem', fontWeight: 600, color: '#334155', marginBottom: 6 }}>카테고리 / 서브카테고리</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <select
                  value={category || ''}
                  onChange={e => {
                    const nextCategory = e.target.value as Category;
                    if (!nextCategory) {
                      setCategory(null);
                      setSubcategory(null);
                      return;
                    }
                    setCategory(nextCategory);
                    setSubcategory(subcategories[nextCategory][0]?.key || null);
                  }}
                >
                  <option value="">카테고리 선택</option>
                  <option value="technical">테크니컬 미션</option>
                  <option value="game">실전 미션</option>
                </select>

                <select
                  value={subcategory || ''}
                  onChange={e => setSubcategory((e.target.value as SubCategory) || null)}
                  disabled={!category}
                >
                  <option value="">서브카테고리 선택</option>
                  {(category ? subcategories[category] : []).map(item => (
                    <option key={item.key} value={item.key}>{item.label}</option>
                  ))}
                </select>
              </div>
              <div style={{ marginTop: 6, fontSize: '0.8rem', color: '#64748b' }}>
                현재 선택: {category ? (category === 'technical' ? '테크니컬' : '실전') : '없음'} / {subcategory ? (subcategories[category as Category]?.find(s => s.key === subcategory)?.label || subcategory) : '없음'}
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
              <button type="button" style={{ background: newTemplateMode === 'form' ? '#0f766e' : '#94a3b8' }} onClick={() => { setNewTemplateMode('form'); setIsTemplatePublishedForNewMission(false); }}>
                필드형 템플릿
              </button>
              <button type="button" style={{ background: newTemplateMode === 'grid' ? '#0f766e' : '#94a3b8' }} onClick={() => { setNewTemplateMode('grid'); setIsTemplatePublishedForNewMission(false); }}>
                엑셀 시트형 템플릿
              </button>
            </div>

            {newTemplateMode === 'form' ? (
              <>
                {newMissionTemplateFields.length === 0 && (
                  <p style={{ margin: '0 0 8px', color: '#64748b' }}>아직 필드가 없습니다. 아래에서 필드를 추가하세요.</p>
                )}

                {newMissionTemplateFields.map((field, idx) => (
                  <div key={field.key} style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: 8, marginBottom: 8, background: '#f8fafc' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px 90px 70px', gap: 6 }}>
                      <input
                        value={field.label}
                        placeholder="필드명"
                        onChange={e => {
                          const value = e.target.value;
                          setNewMissionTemplateFields(prev => prev.map((f, i) => i === idx ? { ...f, label: value, key: f.key || `field_${idx + 1}` } : f));
                        }}
                      />
                      <select
                        value={field.type}
                        onChange={e => setNewMissionTemplateFields(prev => prev.map((f, i) => i === idx ? { ...f, type: e.target.value as TemplateFieldType } : f))}
                      >
                        <option value="text">텍스트</option>
                        <option value="number">숫자</option>
                        <option value="select">선택</option>
                      </select>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.85rem' }}>
                        <input
                          type="checkbox"
                          checked={field.required}
                          onChange={e => setNewMissionTemplateFields(prev => prev.map((f, i) => i === idx ? { ...f, required: e.target.checked } : f))}
                        />필수
                      </label>
                      <button
                        type="button"
                        style={{ fontSize: '0.75rem', padding: '4px 6px', background: '#ef4444' }}
                        onClick={() => setNewMissionTemplateFields(prev => prev.filter((_, i) => i !== idx))}
                      >
                        삭제
                      </button>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 6 }}>
                      <input
                        value={field.placeholder || ''}
                        placeholder="입력 힌트 (placeholder)"
                        onChange={e => {
                          const value = e.target.value;
                          setNewMissionTemplateFields(prev => prev.map((f, i) => i === idx ? { ...f, placeholder: value } : f));
                        }}
                      />
                      <input
                        value={field.helpText || ''}
                        placeholder="도움말"
                        onChange={e => {
                          const value = e.target.value;
                          setNewMissionTemplateFields(prev => prev.map((f, i) => i === idx ? { ...f, helpText: value } : f));
                        }}
                      />
                    </div>
                    {field.type === 'select' && (
                      <input
                        style={{ marginTop: 6 }}
                        value={(field.options || []).join(',')}
                        placeholder="선택지 (콤마로 구분)"
                        onChange={e => {
                          const options = e.target.value.split(',').map(v => v.trim()).filter(Boolean);
                          setNewMissionTemplateFields(prev => prev.map((f, i) => i === idx ? { ...f, options } : f));
                        }}
                      />
                    )}
                  </div>
                ))}

                {newMissionTemplateFields.length > 0 && (
                  <div style={{ marginTop: 10, border: '1px solid #dbe4f0', borderRadius: 8, padding: 10, background: '#ffffff' }}>
                    <div style={{ fontSize: '0.86rem', fontWeight: 700, color: '#334155', marginBottom: 6 }}>선수 입력 화면 미리보기</div>
                    <div style={{ display: 'grid', gap: 8 }}>
                      {newMissionTemplateFields.map(field => (
                        <div key={`preview_${field.key}`} style={{ border: '1px solid #eef2f7', borderRadius: 6, padding: 8, background: '#f8fafc' }}>
                          <label style={{ display: 'block', marginBottom: 4, fontSize: '0.83rem', color: '#1f2937', fontWeight: 600 }}>
                            {field.label || '(필드명 미입력)'} {field.required ? '*' : ''}
                          </label>
                          {field.type === 'select' ? (
                            <select disabled style={{ width: '100%', opacity: 0.9 }}>
                              <option>{field.placeholder || '선택하세요'}</option>
                              {(field.options || []).map(opt => (
                                <option key={opt}>{opt}</option>
                              ))}
                            </select>
                          ) : (
                            <input
                              type={field.type === 'number' ? 'number' : 'text'}
                              disabled
                              placeholder={field.placeholder || '값을 입력하세요'}
                              style={{ width: '100%', opacity: 0.9 }}
                            />
                          )}
                          {field.helpText ? (
                            <div style={{ marginTop: 4, fontSize: '0.78rem', color: '#64748b' }}>{field.helpText}</div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div style={{ border: '1px solid #dbe4f0', borderRadius: 8, padding: 10, background: '#ffffff', marginBottom: 8 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 110px 110px 130px', gap: 6, marginBottom: 8 }}>
                  <input value={newGridTitle} placeholder="시트 제목" onChange={e => { setNewGridTitle(e.target.value); setIsTemplatePublishedForNewMission(false); }} />
                  <input type="number" min={1} max={20} value={newGridRows} onChange={e => { setNewGridRows(Math.max(1, Math.min(20, Number(e.target.value) || 1))); setIsTemplatePublishedForNewMission(false); }} />
                  <input type="number" min={1} max={10} value={newGridCols} onChange={e => { setNewGridCols(Math.max(1, Math.min(10, Number(e.target.value) || 1))); setIsTemplatePublishedForNewMission(false); }} />
                  <input type="number" min={0} value={newGridSuccessThreshold} placeholder="성공 기준값" onChange={e => { setNewGridSuccessThreshold(Number(e.target.value) || 0); setIsTemplatePublishedForNewMission(false); }} />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <div>
                    <div style={{ fontSize: '0.8rem', color: '#475569', marginBottom: 4 }}>행 제목</div>
                    {Array.from({ length: newGridRows }).map((_, idx) => (
                      <input key={`rh_${idx}`} style={{ marginBottom: 4 }} value={newGridRowHeaders[idx] || ''} onChange={e => {
                        const value = e.target.value;
                        setNewGridRowHeaders(prev => {
                          const next = [...prev];
                          next[idx] = value;
                          return next;
                        });
                        setIsTemplatePublishedForNewMission(false);
                      }} placeholder={`행 ${idx + 1}`} />
                    ))}
                  </div>
                  <div>
                    <div style={{ fontSize: '0.8rem', color: '#475569', marginBottom: 4 }}>열 제목</div>
                    {Array.from({ length: newGridCols }).map((_, idx) => (
                      <input key={`ch_${idx}`} style={{ marginBottom: 4 }} value={newGridColHeaders[idx] || ''} onChange={e => {
                        const value = e.target.value;
                        setNewGridColHeaders(prev => {
                          const next = [...prev];
                          next[idx] = value;
                          return next;
                        });
                        setIsTemplatePublishedForNewMission(false);
                      }} placeholder={`열 ${idx + 1}`} />
                    ))}
                  </div>
                </div>

                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: '0.86rem', fontWeight: 700, color: '#334155', marginBottom: 6 }}>선수 입력 시트 미리보기 (빈칸만 입력)</div>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ borderCollapse: 'collapse', minWidth: 420, width: '100%' }}>
                      <thead>
                        <tr>
                          <th style={{ border: '1px solid #dbe4f0', background: '#f1f5f9', padding: '4px 6px' }}>구분</th>
                          {Array.from({ length: newGridCols }).map((_, c) => (
                            <th key={`ph_${c}`} style={{ border: '1px solid #dbe4f0', background: '#f1f5f9', padding: '4px 6px' }}>
                              {newGridColHeaders[c] || `열 ${c + 1}`}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {Array.from({ length: newGridRows }).map((_, r) => (
                          <tr key={`pr_${r}`}>
                            <td style={{ border: '1px solid #dbe4f0', background: '#f8fafc', padding: '4px 6px', fontWeight: 600 }}>
                              {newGridRowHeaders[r] || `행 ${r + 1}`}
                            </td>
                            {Array.from({ length: newGridCols }).map((_, c) => (
                              <td key={`pc_${r}_${c}`} style={{ border: '1px solid #dbe4f0', padding: 4 }}>
                                <input disabled placeholder="입력" style={{ width: '100%', background: '#fff' }} />
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                style={{ background: '#0f766e' }}
                onClick={() => {
                  if (newTemplateMode !== 'form') {
                    alert('필드 추가는 필드형 템플릿 모드에서 사용하세요.');
                    return;
                  }
                  setNewMissionTemplateFields(prev => [
                    ...prev,
                    {
                      key: `field_${Date.now()}`,
                      label: '',
                      type: 'text',
                      required: false,
                      options: [],
                      placeholder: '',
                      helpText: '',
                    }
                  ]);
                  setIsTemplatePublishedForNewMission(false);
                }}
              >
                필드 추가
              </button>
              <button
                type="button"
                style={{ background: '#16a34a' }}
                onClick={() => {
                  if (newTemplateMode === 'form') {
                    if (newMissionTemplateFields.length === 0) {
                      alert('최소 1개 이상의 필드를 추가하세요.');
                      return;
                    }
                    if (newMissionTemplateFields.some(f => !f.label.trim())) {
                      alert('모든 필드명(label)을 입력하세요.');
                      return;
                    }
                  } else {
                    if (newGridRows < 1 || newGridCols < 1) {
                      alert('행/열 수는 1 이상이어야 합니다.');
                      return;
                    }
                    if (newGridRowHeaders.some(v => !v || !v.trim()) || newGridColHeaders.some(v => !v || !v.trim())) {
                      alert('시트형 템플릿은 모든 행/열 제목을 입력해야 합니다.');
                      return;
                    }
                  }
                  setIsTemplatePublishedForNewMission(true);
                  setShowTemplateDesigner(false);
                }}
              >
                템플릿 배포 완료
              </button>
              <button type="button" className="grey-action" onClick={() => setShowTemplateDesigner(false)}>닫기</button>
            </div>
          </div>
        </div>
      )}

      {!isCoach && (
        <div style={{ marginTop: 24, borderTop: '1px solid #eee', paddingTop: 12 }}>
          <h3>수행 예정 미션</h3>
          <p>미션 수행 후 결과를 기록하고 코치 피드백을 받을 수 있습니다.</p>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <label style={{ fontSize: '0.9rem' }}>
              <input type="checkbox" checked={showMineOnly} onChange={e => setShowMineOnly(e.target.checked)} /> 내 할당 미션만 보기
            </label>
            <select value={missionFilter} onChange={e => setMissionFilter(e.target.value as any)} style={{ padding: '4px 8px' }}>
              <option value="all">전체</option>
              <option value="latest">최신</option>
              <option value="pending">미완료</option>
              <option value="completed">완료</option>
            </select>
          </div>
          {(() => {
            let available = missions
              .filter(m => m.assigned_to === 'all' || m.assigned_to === currentPlayer);

            if (category && subcategory) {
              available = available.filter(m => m.category === category && m.subcategory === subcategory);
            }

            if (showMineOnly && currentPlayer) {
              available = available.filter(m => m.assigned_to === currentPlayer);
            }

            if (missionFilter === 'pending') {
              available = available.filter(m => latestMissionStatusById[m.id] === 'pending');
            } else if (missionFilter === 'completed') {
              available = available.filter(m => latestMissionStatusById[m.id] === 'completed');
            }

            available = available.sort((a, b) => new Date(b.inserted_at || '').getTime() - new Date(a.inserted_at || '').getTime());
            const assignedAll = available;
            const assignedLatest = assignedAll[0];
            const assignedCount = assignedAll.length;
            const latest = missionFilter === 'latest' ? assignedLatest : available[0];
            const missionsForList = assignedAll.length > 0 ? assignedAll : available;
            const selectedMission = missionsForList.find(m => m.id === selectedPlayerMissionId);

            return (
              <div>
                <div className="content-section" style={{ marginBottom: 12 }}>
                  <strong>내 할당 미션</strong>
                  <div style={{ marginTop: 8, color: '#444' }}>전체 할당 미션: {assignedCount}개</div>
                  <div style={{ maxHeight: 190, overflowY: 'auto', marginTop: 8, border: '1px solid #ddd', borderRadius: 6, padding: 8, background: '#fff' }}>
                    {missionsForList.length === 0 ? (
                      <div style={{ color: '#888' }}>할당된 미션이 없습니다.</div>
                    ) : (
                      <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
                        {missionsForList.map(m => (
                          <li
                            key={m.id}
                            onClick={() => setSelectedPlayerMissionId(m.id)}
                            style={{
                              marginBottom: 6,
                              padding: '8px',
                              background: selectedPlayerMissionId === m.id ? '#eef6ff' : '#fafafa',
                              borderRadius: 6,
                              cursor: 'pointer',
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center'
                            }}
                          >
                            <span style={{ fontWeight: selectedPlayerMissionId === m.id ? 700 : 500, color: '#333', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {m.title}
                            </span>
                            <button
                              style={{ fontSize: '0.75rem', padding: '3px 8px' }}
                              onClick={e => {
                                e.stopPropagation();
                                setSelectedPlayerMissionId(m.id);
                                markMissionViewed(m.id);
                              }}
                            >
                              보기
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>

                <div style={{ marginBottom: 12 }}>
                  <strong>최신 미션</strong>
                  {assignedLatest ? (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, padding: '8px', border: '1px solid #dedede', borderRadius: 6, background: '#fff' }}>
                      <span style={{ color: '#333' }}>
                        {assignedLatest.title} · {assignedLatest.category === 'technical' ? '테크니컬' : '실전'} · {assignedLatest.inserted_at ? formatTimeDistance(assignedLatest.inserted_at) : '-'}
                      </span>
                      <button
                        style={{ fontSize: '0.8rem', padding: '4px 10px' }}
                        onClick={() => {
                          setSelectedPlayerMissionId(assignedLatest.id);
                          markMissionViewed(assignedLatest.id);
                        }}
                      >
                        확인
                      </button>
                    </div>
                  ) : (
                    <div style={{ marginTop: 8, color: '#888' }}>새로 할당된 미션이 없습니다.</div>
                  )}
                </div>

                {selectedMission ? (
                  <div style={{ border: '1px solid #d0e4ff', borderRadius: 8, padding: 12, background: '#f9fcff', marginBottom: 16 }}>
                    {(() => {
                      const isSubmitted = latestMissionStatusById[selectedMission.id] === 'completed';
                      const selectedFiles = playerMissionFiles[selectedMission.id] || [];
                      const draftFiles = playerDraftAttachments[selectedMission.id] || [];
                      const missionTemplate = missionTemplates[selectedMission.id];
                      const gridTemplate = missionTemplate?.schema_json?.grid;
                      const currentTemplateValues = playerTemplateValues[selectedMission.id] || {};

                      return (
                        <div style={{ marginBottom: 10, padding: 10, border: '1px solid #d8e4ff', borderRadius: 8, background: '#ffffff' }}>
                          <strong>미션 결과 입력</strong>
                          <textarea
                            rows={4}
                            style={{ width: '100%', marginTop: 8, padding: 8, borderRadius: 6, border: '1px solid #d9dee8', background: isSubmitted ? '#f3f4f6' : '#fff', color: '#1f2937' }}
                            value={playerMissionNotes[selectedMission.id] || ''}
                            onChange={e => setPlayerMissionNotes(prev => ({ ...prev, [selectedMission.id]: e.target.value }))}
                            placeholder="미션 수행 결과를 입력하세요. (자동 임시저장)"
                            disabled={isSubmitted}
                          />

                          {(missionTemplate?.schema_json?.mode || 'form') === 'grid' && gridTemplate ? (
                            <div style={{ marginTop: 8, border: '1px solid #e2e8f0', borderRadius: 6, padding: 8, background: '#f8fafc' }}>
                              <div style={{ fontSize: '0.83rem', color: '#475569', marginBottom: 6 }}>
                                {gridTemplate.title || '템플릿 입력 시트'}
                              </div>
                              <div style={{ overflowX: 'auto' }}>
                                <table style={{ width: '100%', minWidth: 520, borderCollapse: 'collapse' }}>
                                  <thead>
                                    <tr>
                                      <th style={{ border: '1px solid #dbe1ea', background: '#f1f5f9', padding: '4px 6px' }}>구분</th>
                                      {Array.from({ length: gridTemplate.colCount }).map((_, c) => (
                                        <th key={`gc_${c}`} style={{ border: '1px solid #dbe1ea', background: '#f1f5f9', padding: '4px 6px' }}>
                                          {gridTemplate.colHeaders[c] || `열 ${c + 1}`}
                                        </th>
                                      ))}
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {Array.from({ length: gridTemplate.rowCount }).map((_, r) => (
                                      <tr key={`gr_${r}`}>
                                        <td style={{ border: '1px solid #dbe1ea', background: '#f8fafc', padding: '4px 6px', fontWeight: 600 }}>
                                          {gridTemplate.rowHeaders[r] || `행 ${r + 1}`}
                                        </td>
                                        {Array.from({ length: gridTemplate.colCount }).map((_, c) => {
                                          const cellKey = `cell_r${r}_c${c}`;
                                          return (
                                            <td key={cellKey} style={{ border: '1px solid #dbe1ea', padding: 4 }}>
                                              <input
                                                disabled={isSubmitted}
                                                value={currentTemplateValues[cellKey] || ''}
                                                placeholder="입력"
                                                onChange={e => setPlayerTemplateValues(prev => ({
                                                  ...prev,
                                                  [selectedMission.id]: {
                                                    ...(prev[selectedMission.id] || {}),
                                                    [cellKey]: e.target.value,
                                                  },
                                                }))}
                                              />
                                            </td>
                                          );
                                        })}
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>

                              <div style={{ marginTop: 8, borderTop: '1px dashed #cbd5e1', paddingTop: 8 }}>
                                <div style={{ fontSize: '0.8rem', color: '#475569', marginBottom: 4 }}>자동 계산 (합계/평균/표준편차/성공률)</div>
                                {Array.from({ length: gridTemplate.colCount }).map((_, c) => {
                                  const colValues = Array.from({ length: gridTemplate.rowCount })
                                    .map((__, r) => Number(currentTemplateValues[`cell_r${r}_c${c}`]))
                                    .filter(v => Number.isFinite(v));

                                  const sum = colValues.reduce((acc, v) => acc + v, 0);
                                  const avg = colValues.length ? sum / colValues.length : 0;
                                  const stddev = colValues.length > 1
                                    ? Math.sqrt(colValues.reduce((acc, v) => acc + (v - avg) * (v - avg), 0) / (colValues.length - 1))
                                    : 0;
                                  const successCount = colValues.filter(v => v >= (gridTemplate.successThreshold ?? 1)).length;
                                  const successRate = colValues.length ? (successCount / colValues.length) * 100 : 0;

                                  return (
                                    <div key={`calc_${c}`} style={{ fontSize: '0.78rem', color: '#334155', marginBottom: 2 }}>
                                      {gridTemplate.colHeaders[c] || `열 ${c + 1}`}: 합계 {sum.toFixed(2)} / 평균 {avg.toFixed(2)} / 표준편차 {stddev.toFixed(2)} / 성공률 {successRate.toFixed(1)}%
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          ) : missionTemplate?.schema_json?.fields?.length ? (
                            <div style={{ marginTop: 8, border: '1px solid #e2e8f0', borderRadius: 6, padding: 8, background: '#f8fafc' }}>
                              <div style={{ fontSize: '0.83rem', color: '#475569', marginBottom: 6 }}>템플릿 입력 항목</div>
                              {missionTemplate.schema_json.fields.map(field => (
                                <div key={field.key} style={{ marginBottom: 6 }}>
                                  <label style={{ display: 'block', fontSize: '0.82rem', color: '#334155', marginBottom: 2 }}>
                                    {field.label} {field.required ? '*' : ''}
                                  </label>
                                  {field.type === 'select' ? (
                                    <select
                                      disabled={isSubmitted}
                                      value={currentTemplateValues[field.key] || ''}
                                      onChange={e => setPlayerTemplateValues(prev => ({
                                        ...prev,
                                        [selectedMission.id]: {
                                          ...(prev[selectedMission.id] || {}),
                                          [field.key]: e.target.value,
                                        },
                                      }))}
                                    >
                                      <option value="">{field.placeholder || '선택'}</option>
                                      {(field.options || []).map(option => (
                                        <option key={option} value={option}>{option}</option>
                                      ))}
                                    </select>
                                  ) : (
                                    <input
                                      type={field.type === 'number' ? 'number' : 'text'}
                                      disabled={isSubmitted}
                                      placeholder={field.placeholder || '입력'}
                                      value={currentTemplateValues[field.key] || ''}
                                      onChange={e => setPlayerTemplateValues(prev => ({
                                        ...prev,
                                        [selectedMission.id]: {
                                          ...(prev[selectedMission.id] || {}),
                                          [field.key]: e.target.value,
                                        },
                                      }))}
                                    />
                                  )}
                                  {field.helpText ? (
                                    <div style={{ marginTop: 2, fontSize: '0.76rem', color: '#64748b' }}>{field.helpText}</div>
                                  ) : null}
                                </div>
                              ))}
                            </div>
                          ) : null}

                          <div style={{ marginTop: 8 }}>
                            <label style={{ display: 'block', fontSize: '0.85rem', color: '#334155', marginBottom: 4 }}>
                              결과 첨부 파일 (최대 3개)
                            </label>
                            <input
                              type="file"
                              accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.bmp,.gif"
                              multiple
                              disabled={isSubmitted}
                              onChange={e => {
                                if (isSubmitted || !e.target.files) return;
                                const incoming = Array.from(e.target.files);
                                setPlayerMissionFiles(prev => {
                                  const next = [...(prev[selectedMission.id] || []), ...incoming];
                                  if (next.length > 3) {
                                    alert('파일은 최대 3개까지 첨부할 수 있습니다.');
                                    return prev;
                                  }
                                  return { ...prev, [selectedMission.id]: next };
                                });
                              }}
                            />
                            <div style={{ marginTop: 6, fontSize: '0.82rem', color: '#1f2937', background: '#f8fafc', border: '1px solid #dbe1ea', borderRadius: 6, padding: '6px 8px' }}>
                              선택된 파일: {selectedFiles.length > 0 ? selectedFiles.map(f => f.name).join(', ') : '없음'}
                            </div>
                            {draftFiles.length > 0 && (
                              <div style={{ marginTop: 6, fontSize: '0.82rem', color: '#334155' }}>
                                임시 저장 첨부: {draftFiles.map(f => f.name).join(', ')}
                              </div>
                            )}
                          </div>

                          <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            <button
                              type="button"
                              disabled={isSubmitted}
                              onClick={() => saveMissionDraft(selectedMission.id, { includeFiles: false, silent: false })}
                              style={{ fontSize: '0.85rem', padding: '6px 10px', background: '#64748b' }}
                            >
                              임시 저장
                            </button>
                            <button
                              type="button"
                              disabled={isSubmitted}
                              onClick={() => handleCompleteMission(selectedMission.id)}
                              style={{ fontSize: '0.85rem', padding: '6px 10px', background: '#16a34a' }}
                            >
                              미션 완료 제출
                            </button>
                          </div>

                          <div style={{ marginTop: 6, fontSize: '0.8rem', color: isSubmitted ? '#166534' : '#475569' }}>
                            상태: {isSubmitted ? '완료 제출됨 (읽기 전용)' : (draftSaveStatus[selectedMission.id] || '입력 중')}
                          </div>
                        </div>
                      );
                    })()}

                    <h4 style={{ margin: '0 0 8px 0' }}>선택된 미션 상세보기</h4>
                    <h5 style={{ margin: '0 0 6px 0' }}>{selectedMission.title}</h5>
                    <p style={{ margin: '0 0 10px 0', color: '#333' }}>{selectedMission.description}</p>
                    {selectedMission.attachments && selectedMission.attachments.length > 0 && (
                      <div style={{ marginBottom: 8 }}>
                        <strong>첨부파일:</strong>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '4px' }}>
                          {selectedMission.attachments.map((file, idx) => (
                            <button key={idx} style={{ fontSize: '0.75rem', padding: '4px 8px', background: '#f3f4f6', color: '#1f2937', border: '1px solid #d1d5db', fontWeight: 600 }} onClick={() => openAttachment(file)}>
                              {file.name}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    <div style={{ fontSize: '0.9rem', color: '#555', marginBottom: 8 }}>
                      ID: #{selectedMission.id} · 등록: {selectedMission.inserted_at ? formatTimeDistance(selectedMission.inserted_at) : '-'}
                    </div>

                    <div style={{ marginTop: 8, padding: 10, border: '1px solid #ccc', borderRadius: 6, background: '#fff' }}>
                      <strong>미션 대화/피드백 이력</strong>
                      <div style={{ marginTop: 6 }}>
                        {(() => {
                          const missionLogsForSelected = missionLogs
                            .filter(l => l.mission_id === selectedMission.id && l.player_id === currentPlayer)
                            .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

                          if (missionLogsForSelected.length === 0) {
                            return <p style={{ margin: 0, color: '#888' }}>이 미션에 대한 대화/피드백 이력이 없습니다.</p>;
                          }

                          return (
                            <>
                              {missionLogsForSelected.map(log => (
                                <div key={log.id} style={{ marginBottom: 8, padding: 8, background: '#f5f9ff', borderRadius: 6 }}>
                                  <p style={{ margin: '3px 0', fontSize: '0.82rem', color: '#64748b' }}>
                                    {new Date(log.created_at).toLocaleString()} · 상태: {log.status}
                                  </p>
                                  <p style={{ margin: '3px 0', fontSize: '0.9rem', color: '#004d40' }}><strong>선수 코멘트:</strong> {getLogDisplayNote(log.note)}</p>
                                  <p style={{ margin: '3px 0', fontSize: '0.85rem', color: '#1f2937' }}><strong>입력값 요약:</strong> {getTemplateValueSummary(log.mission_id, log.note)}</p>
                                  <p style={{ margin: '3px 0', fontSize: '0.9rem', color: '#b71c1c' }}><strong>코치 코멘트:</strong> {log.coach_feedback || '미등록'}</p>
                                </div>
                              ))}
                            </>
                          );
                        })()}
                      </div>

                      <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px dashed #cbd5e1' }}>
                        <strong>코치에게 메시지 보내기</strong>
                        <textarea
                          rows={3}
                          style={{ width: '100%', marginTop: 6, padding: 8, borderRadius: 6, border: '1px solid #ddd' }}
                          value={missionReply[selectedMission.id] || ''}
                          onChange={e => setMissionReply(prev => ({ ...prev, [selectedMission.id]: e.target.value }))}
                          placeholder="이 미션에 대한 의견을 입력하세요"
                        />
                        <button
                          style={{ marginTop: 8, padding: '6px 10px', fontSize: '0.9rem' }}
                          onClick={() => handleMissionChatSend(selectedMission.id)}
                        >
                          전송
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div style={{ marginBottom: 16, color: '#666' }}>미션을 선택하면 상세 내용을 표시합니다.</div>
                )}
              </div>
            );
          })()}
        </div>
      )}



      {assignModalMission && (
        <div style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: '#fff', padding: 20, borderRadius: 8, width: '90%', maxWidth: 400 }}>
            <h4>미션 {assignModalMission.title} 선수 지정</h4>
            <select value={assignTarget} onChange={e => setAssignTarget(e.target.value)} style={{ width: '100%', marginBottom: 12, padding: 8 }}>
              <option value="">선수를 선택하세요</option>
              {players.map(p => (
                <option key={p.id} value={p.id}>{p.display_name || p.username || p.id}</option>
              ))}
            </select>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => setAssignModalMission(null)}>취소</button>
              <button onClick={assignSelectedPlayer}>지정</button>
            </div>
          </div>
        </div>
      )}
    </div>
  </div>
  );
}

export default App;
