import { useEffect, useMemo, useState } from 'react';
import { supabase } from './supabaseClient';

type Role = 'coach' | 'player' | null;

type Category = 'technical' | 'game';
type SubCategory =
  | 'driver'
  | 'iron'
  | 'putting'
  | 'spin'
  | '18hole'
  | 'chipside'
  | 'approach'
  | 'troubleshot'
  | 'clubdistance';

type Mission = {
  id: number;
  title: string;
  description: string;
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
    { key: 'spin', label: '스핀샷 미션' }
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

function App() {
  const [role, setRole] = useState<Role>(null);
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
  const [assignTo, setAssignTo] = useState('all');
  const [missionFiles, setMissionFiles] = useState<FileList | null>(null);
  const [storageBucket, setStorageBucket] = useState('mission-files');
  const [missionLogs, setMissionLogs] = useState<MissionLog[]>([]);
  const [assignModalMission, setAssignModalMission] = useState<Mission | null>(null);
  const [assignTarget, setAssignTarget] = useState('');
  const [coachFeedback, setCoachFeedback] = useState<Record<number, string>>({});
  const [playerMissionNotes, setPlayerMissionNotes] = useState<Record<number, string>>({});
  const [playerMissionFiles, setPlayerMissionFiles] = useState<Record<number, File[]>>({});
  const [playerReply, setPlayerReply] = useState<Record<number, string>>({});
  const [showVerificationPanel, setShowVerificationPanel] = useState(false);
  const [selectedMissionId, setSelectedMissionId] = useState<number | null>(null);
  const [verifiedPlayers, setVerifiedPlayers] = useState<Record<string, boolean>>({});
  const [viewedMissionIds, setViewedMissionIds] = useState<number[]>([]);
  const [showMineOnly, setShowMineOnly] = useState(false);
  const [missionFilter, setMissionFilter] = useState<'all' | 'latest' | 'pending' | 'completed'>('all');
  const [showAssignedOnly, setShowAssignedOnly] = useState(false);
  const [showSubcategoryDropdown, setShowSubcategoryDropdown] = useState(false);
  const [playerPasswordInputs, setPlayerPasswordInputs] = useState<Record<string, string>>({});

  const filteredMissions = useMemo(() => {
    if (!category || !subcategory) return [];
    const categoryFiltered = missions.filter(m => m.category === category && m.subcategory === subcategory);
    if (role === 'player' && currentPlayer) {
      return categoryFiltered.filter(m => m.assigned_to === 'all' || m.assigned_to === currentPlayer);
    }
    return categoryFiltered;
  }, [missions, category, subcategory, role, currentPlayer]);

  const visibleMissions = selectedMissionId !== null ? filteredMissions.filter(m => m.id === selectedMissionId) : [];

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
      const missionsWithNames = (data as Mission[]).map(m => {
        const player = players.find(p => p.id === m.assigned_to);
        const assignedName = player
          ? player.display_name || player.username || player.id
          : m.assigned_to === '미정'
          ? '미정'
          : m.assigned_to;
        return { ...m, assigned_name: assignedName };
      });
      setMissions(missionsWithNames);
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
        console.warn('버킷 목록 조회 실패:', listError);
      }
      if (buckets?.some(b => b.name === 'mission-files')) {
        setStorageBucket('mission-files');
        return;
      }
      if (buckets?.some(b => b.name === 'attachments')) {
        setStorageBucket('attachments');
        return;
      }
    } catch (bucketError) {
      console.warn('버킷 목록 조회 실패(권한 이슈 가능). mission-files 우선 사용 시도:', bucketError);
    }

    // 없으면 일단 mission-files 시도
    try {
      const { data: created, error: createError } = await supabase.storage.createBucket('mission-files', { public: true });
      if (!createError) {
        setStorageBucket('mission-files');
        console.info('mission-files 버킷 생성 완료:', created);
        return;
      }
      console.warn('mission-files 버킷 생성 실패:', createError);
    } catch (createError) {
      console.warn('mission-files 버킷 생성 예외:', createError);
    }

    // mission-files 생성 실패시 attachments 시도
    try {
      const { data: created, error: createError } = await supabase.storage.createBucket('attachments', { public: true });
      if (!createError) {
        setStorageBucket('attachments');
        console.info('attachments 버킷 생성 완료:', created);
        return;
      }
      console.warn('attachments 버킷 생성 실패:', createError);
    } catch (createError) {
      console.warn('attachments 버킷 생성 예외:', createError);
    }

    setStorageBucket('mission-files');
  };

  const getAttachmentUrl = async (path: string, bucketHint?: string): Promise<string> => {
    if (!path) return '';
    if (path.startsWith('http://') || path.startsWith('https://')) return path;

    const rawPath = path.trim();
    const cleanedPath = rawPath.replace(/^\/+/, '');

    // path에 bucket 이름이 포함된 케이스 지원: mission-files/file.jpg 또는 attachments/file.jpg
    let directBucket: string | undefined;
    let objectPath = cleanedPath;
    const parts = cleanedPath.split('/');
    if (parts.length > 1 && ['mission-files', 'attachments'].includes(parts[0])) {
      directBucket = parts[0];
      objectPath = parts.slice(1).join('/');
    }

    const bucketsToTry = new Set<string>();
    if (directBucket) bucketsToTry.add(directBucket);
    if (bucketHint) bucketsToTry.add(bucketHint);
    if (storageBucket) bucketsToTry.add(storageBucket);
    ['mission-files', 'attachments'].forEach(b => bucketsToTry.add(b));

    for (const bucket of bucketsToTry) {
      try {
        const signed = await supabase.storage.from(bucket).createSignedUrl(objectPath, 60 * 60);
        if (!signed.error && signed.data?.signedUrl) {
          console.debug('getAttachmentUrl (signedUrl) 성공', { bucket, path: objectPath });
          return signed.data.signedUrl;
        }

        if (signed.error) {
          console.debug('getAttachmentUrl: createSignedUrl 실패', { bucket, path: objectPath, message: signed.error.message });
        }

        const publicResult = supabase.storage.from(bucket).getPublicUrl(objectPath);
        if (publicResult.data?.publicUrl) {
          console.debug('getAttachmentUrl (publicUrl) 성공', { bucket, path: objectPath, url: publicResult.data.publicUrl });
          return publicResult.data.publicUrl;
        }
      } catch (error) {
        console.warn('getAttachmentUrl 오류:', bucket, objectPath, error);
      }
    }

    console.warn('getAttachmentUrl: 모든 버킷에서 실패', { path: objectPath, hintedBucket: bucketHint, storageBucket });
    return '';
  };

  const openAttachment = async (file: {name:string;path:string;url?:string;bucket?:string}) => {
    const urlCandidates: string[] = [];

    if (file.path) {
      const generated = await getAttachmentUrl(file.path, file.bucket);
      if (generated) {
        urlCandidates.push(generated);
      }
    }

    // URL에서 bucket/path 추출을 시도
    if (file.url) {
      const match = file.url.match(/storage\/v1\/object\/public\/([^/]+)\/(.+)$/);
      if (match) {
        const [, parsedBucket, parsedPath] = match;
        const generatedFromUrl = await getAttachmentUrl(parsedPath, parsedBucket);
        if (generatedFromUrl && !urlCandidates.includes(generatedFromUrl)) {
          urlCandidates.push(generatedFromUrl);
        }
      }

      if (!urlCandidates.includes(file.url)) {
        urlCandidates.push(file.url);
      }
    }

    for (const url of urlCandidates) {
      try {
        console.debug('openAttachment 시도 URL:', url);
        window.open(url, '_blank');
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

  useEffect(() => {
    const init = async () => {
      await loadPlayers();
      await loadMissions();
      await loadMissionLogs();
      await cleanOldAttachments();
    };
    init();
  }, []);

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

  const handleAddMission = async () => {
    if (!currentCoach) {
      alert('코치로 로그인된 상태여야 합니다.');
      return;
    }

    if (!newMission.title.trim() || !newMission.description.trim()) {
      alert('모든 미션 정보를 입력해주세요.');
      return;
    }

    const mission: any = {
      title: newMission.title,
      description: newMission.description,
      category,
      subcategory,
      created_by: currentCoach,
      assigned_to: assignTo === 'unassigned' ? '미정' : assignTo,
      attachments: []
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

    if (missionFiles && missionFiles.length > 0) {
      try {
        await ensureMissionBucket();
      } catch (err) {
        console.error('버킷 확인 오류:', err);
        alert('스토리지 버킷 확인 오류가 발생했습니다. 콘솔을 확인하세요.');
        return;
      }

      try {
        mission.attachments = await uploadMissionFiles(Array.from(missionFiles));
      } catch (uploadError: any) {
        console.error('파일 업로드 실패:', uploadError);
        alert('파일 업로드 중 오류가 발생했습니다. 콘솔을 확인하세요: ' + (uploadError?.message || uploadError));
        return;
      }
    }

    const { data, error } = await supabase.from('missions').insert([mission]).select();
    if (error) {
      console.error('미션 등록 실패:', error);
      alert('미션 등록 실패: ' + (error?.message || JSON.stringify(error)));
      return;
    }

    setNewMission({ id: '', title: '', description: '' });
    setAssignTo('all');
    setMissionFiles(null);
    loadMissions();
  };

  const uploadMissionFiles = async (files: File[]) => {
    if (files.length === 0) return [];

    await ensureMissionBucket();

    const attachments: { name: string; url: string; path: string; bucket?: string }[] = [];

    for (let idx = 0; idx < files.length && idx < 3; idx++) {
      const file = files[idx];
      const filePath = `player_${Date.now()}_${file.name}`;

      let usedBucket = storageBucket;
      let uploadResult = await supabase.storage
        .from(usedBucket)
        .upload(filePath, file, { cacheControl: '3600', upsert: false });

      if (uploadResult.error) {
        // mission-files 버킷이 없는 경우 attachments로 폴백
        if (uploadResult.error.message?.includes('Bucket not found') && usedBucket === 'mission-files') {
          console.warn('mission-files 버킷 없음, attachments로 폴백합니다.');
          usedBucket = 'attachments';
          setStorageBucket('attachments');
          uploadResult = await supabase.storage
            .from(usedBucket)
            .upload(filePath, file, { cacheControl: '3600', upsert: false });
        }
      }

      if (uploadResult.error) {
        console.error('파일 업로드 실패:', uploadResult.error);
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

    const note = playerMissionNotes[missionId]?.trim() || '완료';
    const files = playerMissionFiles[missionId] || [];

    let attachments: { name: string; url: string; path: string }[] = [];
    try {
      attachments = await uploadMissionFiles(files);
    } catch (uploadError: any) {
      alert('첨부파일 업로드 실패: ' + (uploadError?.message || uploadError));
      return;
    }

    const mission = missions.find(m => m.id === missionId);
    if (mission && attachments.length > 0) {
      const merged = [...(mission.attachments || []), ...attachments];
      const { error: updateError } = await supabase
        .from('missions')
        .update({ attachments: merged })
        .eq('id', missionId);
      if (updateError) {
        console.error('미션 첨부 업데이트 실패:', updateError);
      }
    }

    const { data, error } = await supabase
      .from('mission_logs')
      .insert([
        {
          mission_id: missionId,
          player_id: currentPlayer,
          status: 'completed',
          note,
          coach_feedback: null
        }
      ])
      .select();

    if (error || !data) {
      alert('미션 완료 제출 실패: ' + error?.message);
      return;
    }

    setPlayerMissionNotes(prev => ({ ...prev, [missionId]: '' }));
    setPlayerMissionFiles(prev => ({ ...prev, [missionId]: [] }));
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
    if (mission?.attachments?.length) {
      for (const attachment of mission.attachments) {
        const { error: removeError } = await supabase.storage.from(storageBucket).remove([attachment.path]);
        if (removeError) {
          console.warn('첨부파일 삭제 실패:', attachment.path, removeError);
        }
      }
    }

    const { error } = await supabase
      .from('missions')
      .delete()
      .eq('id', missionId);

    if (error) {
      console.error('미션 삭제 오류:', error);
      alert('미션 삭제에 실패했습니다.');
      return;
    }

    loadMissions();
  };

  const onOpenAssignModal = (mission: Mission) => {
    setAssignModalMission(mission);
    setAssignTarget('');
  };

  const assignSelectedPlayer = async () => {
    if (!assignModalMission || !assignTarget) {
      alert('선수를 선택하세요.');
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

    // 선수 관련 로그와 피드백도 함께 삭제
    const { error: logError } = await supabase
      .from('mission_logs')
      .delete()
      .eq('player_id', playerId);

    if (logError) {
      console.error('선수 미션 로그 삭제 실패:', logError);
      alert('선수 미션 로그 삭제 중 오류가 발생했습니다. 콘솔을 확인하세요.');
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

  const isCoach = role === 'coach';
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

  return (
    <div style={{
      minHeight: '100vh',
      background: '#f2f6ef',
      padding: '12px 8px',
      display: 'flex',
      justifyContent: 'center',
      boxSizing: 'border-box',
    }}>
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

          <div style={{ maxHeight: 220, overflowY: 'auto', overflowX: 'hidden', border: '1px solid #ddd', borderRadius: 6, marginBottom: 16 }}>
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
                {filteredMissions.map(m => (
                  <tr
                    key={m.id}
                    onClick={() => setSelectedMissionId(m.id)}
                    style={{
                      cursor: 'pointer',
                      background: selectedMissionId === m.id ? '#eef6ff' : '#fff',
                      borderBottom: '1px solid #f0f0f0'
                    }}
                  >
                    <td style={{ padding: '6px 8px', width: '14.2857%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>#{m.id}</td>
                    <td style={{ padding: '6px 8px', width: '42.8571%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.title}</td>
                    <td style={{ padding: '6px 8px', width: '14.2857%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.assigned_to === '미정' ? '미정' : getPlayerLabel(m.assigned_to)}</td>
                    <td style={{ padding: '6px 8px', width: '28.5714%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.inserted_at ? new Date(m.inserted_at).toLocaleString() : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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
                                <a
                                  href={file.url || '#'}
                                  download={file.name}
                                  target="_blank"
                                  rel="noreferrer"
                                  onClick={async e => {
                                    e.preventDefault();
                                    await openAttachment(file);
                                  }}
                                >
                                  {file.name}
                                </a>
                                <button
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
                        ID: #{m.id} / 작성: {m.created_by} / 할당: {m.assigned_to === '미정' ? '미정' : (m.assigned_name || getPlayerLabel(m.assigned_to))}
                      </p>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {m.assigned_to === '미정' ? (
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
          <h3>미션 추가</h3>
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
              <option value="미정">미정</option>
              {players.map(p => (
                <option key={p.id} value={p.id}>
                  선수 {p.display_name || p.username || p.id}
                </option>
              ))}
            </select>
            <p style={{ margin: '4px 0 0', color: '#666', fontSize: '0.85rem' }}>
              미정 선택 시 선수에게 미할당 상태로 잠시 보관됩니다.
            </p>
          </div>
          <div style={{ marginBottom: 8 }}>
            <label>첨부 파일 (최대 3개):&nbsp;</label>
            <input
              type="file"
              multiple
              onChange={e => {
                if (e.target.files) {
                  const files = Array.from(e.target.files);
                  if (files.length > 3) {
                    alert('파일은 최대 3개까지 첨부할 수 있습니다.');
                    e.target.value = '';
                    setMissionFiles(null);
                  } else {
                    setMissionFiles(e.target.files);
                  }
                }
              }}
            />
          </div>
          <button onClick={handleAddMission}>미션 등록</button>
        </div>
      )}

      {isCoach && (
        <div style={{ marginTop: 24, borderTop: '1px solid #eee', paddingTop: 12 }}>
          <h3>코치 미션 로그 / 피드백 관리</h3>
          <div style={{ maxHeight: 440, overflowY: 'auto', paddingRight: 6 }}>
            {missionLogs.map(log => (
              <div key={log.id} style={{ border: '1px dashed #666', marginBottom: 8, padding: 8 }}>
                <div>로그 ID: {log.id}</div>
                <div>미션 ID: {log.mission_id}</div>
                <div>선수: {getPlayerLabel(log.player_id)}</div>
                <div>상태: {log.status}</div>
                <div>선수코멘트: {log.note}</div>
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
              .filter(m => m.category === category && m.subcategory === subcategory)
              .filter(m => !showMineOnly || m.assigned_to === 'all' || m.assigned_to === currentPlayer);

            const missionStatusMap = new Map<number, 'pending' | 'completed'>(missionLogs.map(log => [log.mission_id, log.status]));
            if (missionFilter === 'pending') {
              available = available.filter(m => missionStatusMap.get(m.id) === 'pending');
            } else if (missionFilter === 'completed') {
              available = available.filter(m => missionStatusMap.get(m.id) === 'completed');
            }

            available = available.sort((a, b) => new Date(b.inserted_at || '').getTime() - new Date(a.inserted_at || '').getTime());
            const assignedAll = available.filter(m => m.assigned_to === 'all' || m.assigned_to === currentPlayer);
            const assignedLatest = assignedAll[0];
            const assignedCount = assignedAll.length;
            const latest = missionFilter === 'latest' ? assignedLatest : available[0];
            const rest = available.filter(m => latest ? m.id !== latest.id : true);

            return (
              <>
                <div className="content-section" style={{ marginBottom: 12 }}>
                  <strong>내 할당 미션</strong>
                  <div style={{ marginTop: 8, color: '#444' }}>
                    전체 할당 미션: {assignedCount}개
                  </div>
                  {assignedLatest ? (
                    <div style={{ marginTop: 8, color: '#1a73e8', fontWeight: 600 }}>
                      최신 할당 미션: {assignedLatest.title} ({assignedLatest.category === 'technical' ? '테크니컬' : '실전'})
                    </div>
                  ) : (
                    <div style={{ marginTop: 8, color: '#888' }}>새로 할당된 미션이 없습니다.</div>
                  )}
                </div>
                {latest ? (
                  <div className="content-block-alt" style={{ marginBottom: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                      <strong>최신 미션</strong>
                      <span style={{ fontSize: '0.85rem', color: '#666' }}>{viewedMissionIds.includes(latest.id) ? '열람 완료' : 'NEW'}</span>
                    </div>
                    <h4 style={{ margin: '0 0 6px 0' }}>{latest.title}</h4>
                    <p style={{ margin: '0 0 8px 0' }}>{latest.description}</p>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <p style={{ margin: 0, color: '#555' }}>ID: #{latest.id} / 등록: {latest.inserted_at ? formatTimeDistance(latest.inserted_at) : '-'}</p>
                      <button onClick={() => markMissionViewed(latest.id)} style={{ fontSize: '0.8rem', padding: '4px 8px' }}>
                        확인
                      </button>
                    </div>
                  </div>
                ) : (
                  <p>할당된 미션이 없습니다.</p>
                )}

                {rest.length > 0 && (
                  <div className="mission-list-container">
                    {rest.map(m => (
                      <div key={m.id} style={{ borderBottom: '1px solid #e9ecef', padding: '8px 0', opacity: viewedMissionIds.includes(m.id) ? 0.6 : 1 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <strong>{m.title}</strong>
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <span style={{ fontSize: '0.8rem', color: '#999' }}>{formatTimeDistance(m.inserted_at)}</span>
                            <span style={{ fontSize: '0.75rem', color: viewedMissionIds.includes(m.id) ? '#888' : '#d9534f' }}>
                              {viewedMissionIds.includes(m.id) ? '열람 완료' : 'NEW'}
                            </span>
                            {!viewedMissionIds.includes(m.id) && (
                              <button onClick={() => markMissionViewed(m.id)} style={{ fontSize: '0.7rem', padding: '2px 6px' }}>
                                확인
                              </button>
                            )}
                          </div>
                        </div>
                        <p style={{ margin: '4px 0', color: '#666' }}>{m.description}</p>
                      </div>
                    ))}
                  </div>
                )}
              </>
            );
          })()}

          <div style={{ marginTop: 24 }}>
            <h3>나의 미션 로그</h3>
            {missionLogs
              .filter(log => log.player_id === currentPlayer)
              .map(log => (
                <div key={log.id} style={{ border: '1px dashed #999', marginBottom: 8, padding: 8 }}>
                  <div>미션 ID: {log.mission_id}</div>
                  <div>상태: {log.status}</div>
                  <div>작성일: {new Date(log.created_at).toLocaleString()}</div>
                  <div>선수코멘트: {log.note}</div>
                  <div>코치: {log.coach_feedback || '미등록'}</div>
                  <div style={{ marginTop: 8 }}>
                    <textarea
                      value={playerReply[log.id] || ''}
                      onChange={e => setPlayerReply(prev => ({ ...prev, [log.id]: e.target.value }))}
                      placeholder="코치에게 추가 의견 보내기"
                      style={{ width: '100%', minHeight: 48, marginBottom: 6 }}
                    />
                    <button onClick={() => handlePlayerReply(log.id, log.mission_id)}>
                      코멘트 답장 보내기
                    </button>
                  </div>
                </div>
              ))}
          </div>
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
