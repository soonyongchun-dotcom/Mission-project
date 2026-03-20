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
};

type MissionLog = {
  id: number;
  mission_id: number;
  player_id: string;
  status: 'pending' | 'completed';
  note: string;
  coach_feedback: string | null;
  created_at: string;
};

function App() {
  const [role, setRole] = useState<Role>(null);
  const [coachCode, setCoachCode] = useState('');
  const [playerId, setPlayerId] = useState('');
  const [currentPlayer, setCurrentPlayer] = useState<string | null>(null);
  const [currentCoach, setCurrentCoach] = useState<string | null>(null);
  const [category, setCategory] = useState<Category>('technical');
  const [subcategory, setSubcategory] = useState<SubCategory>('driver');
  const [missions, setMissions] = useState<Mission[]>([]);
  const [players, setPlayers] = useState<User[]>([]);
  const [newMission, setNewMission] = useState({ title: '', description: '' });
  const [assignTo, setAssignTo] = useState('all');
  const [missionLogs, setMissionLogs] = useState<MissionLog[]>([]);
  const [playerNote, setPlayerNote] = useState('');
  const [coachFeedback, setCoachFeedback] = useState<Record<number, string>>({});

  const filteredMissions = useMemo(() => {
    const categoryFiltered = missions.filter(m => m.category === category && m.subcategory === subcategory);
    if (role === 'player' && currentPlayer) {
      return categoryFiltered.filter(m => m.assigned_to === 'all' || m.assigned_to === currentPlayer);
    }
    return categoryFiltered;
  }, [missions, category, subcategory, role, currentPlayer]);

  const loadMissions = async () => {
    const { data, error } = await supabase
      .from('missions')
      .select('*')
      .order('id', { ascending: false });

    if (error) {
      console.error('Failed to load missions:', error);
      return;
    }

    if (data) setMissions(data);
  };

  const loadPlayers = async () => {
    const { data, error } = await supabase
      .from('users')
      .select('id, role, coach_code')
      .eq('role', 'player');

    if (error) {
      console.error('Failed to load players:', error);
      return;
    }

    if (data) setPlayers(data);
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
    loadMissions();
    loadPlayers();
    loadMissionLogs();
  }, []);

  const handleLoginAsCoach = async () => {
    if (!coachCode.trim()) {
      alert('코치 코드를 입력해주세요');
      return;
    }

    const { data, error } = await supabase
      .from('users')
      .select('id, role, coach_code')
      .eq('role', 'coach')
      .eq('coach_code', coachCode)
      .single();

    if (error || !data) {
      alert('유효한 코치 코드가 없습니다. 코치 계정을 먼저 생성해주세요.');
      return;
    }

    setRole('coach');
    setCurrentCoach(data.id);
    setCurrentPlayer(null);
  };

  const handleLoginAsPlayer = async () => {
    if (!playerId.trim()) {
      alert('선수 아이디를 입력해주세요');
      return;
    }

    const { data, error } = await supabase
      .from('users')
      .select('id, role, coach_code')
      .eq('role', 'player')
      .eq('id', playerId)
      .single();

    if (error || !data) {
      alert('유효한 선수 아이디가 없습니다. 선수 계정을 먼저 생성해주세요.');
      return;
    }

    setRole('player');
    setCurrentPlayer(data.id);
    setCurrentCoach(data.coach_code);
  };

  const handleCreateUser = async (roleToCreate: Role) => {
    if (!coachCode.trim() && roleToCreate === 'coach') {
      alert('코치 코드가 필요합니다.');
      return;
    }

    if (roleToCreate === 'coach') {
      const newCoachCode = coachCode.trim();
      const { data, error } = await supabase
        .from('users')
        .insert([{ role: 'coach', coach_code: newCoachCode }])
        .select();

      if (error || !data) {
        alert('코치 생성 실패: ' + error?.message);
        return;
      }
      alert('코치 생성 완료: ' + data[0].id);
      return;
    }

    const { data, error } = await supabase
      .from('users')
      .insert([{ role: 'player', coach_code: coachCode.trim() }])
      .select();

    if (error || !data) {
      alert('선수 생성 실패: ' + error?.message);
      return;
    }

    alert('선수 생성 완료: 선수ID=' + data[0].id);
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

    const mission: Omit<Mission, 'id'> = {
      title: newMission.title,
      description: newMission.description,
      category,
      subcategory,
      created_by: currentCoach,
      assigned_to: assignTo
    };

    const { data, error } = await supabase.from('missions').insert([mission]).select();
    if (error || !data) {
      alert('미션 추가 실패: ' + error?.message);
      return;
    }

    setNewMission({ title: '', description: '' });
    setAssignTo('all');
    loadMissions();
  };

  const handleCompleteMission = async (missionId: number) => {
    if (!currentPlayer) {
      alert('선수로 로그인된 상태여야 합니다.');
      return;
    }

    const { data, error } = await supabase
      .from('mission_logs')
      .insert([
        {
          mission_id: missionId,
          player_id: currentPlayer,
          status: 'completed',
          note: playerNote || '완료',
          coach_feedback: null
        }
      ])
      .select();

    if (error || !data) {
      alert('미션 기록 실패: ' + error?.message);
      return;
    }

    setPlayerNote('');
    loadMissionLogs();
    alert('미션 수행이 기록되었습니다.');
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
        <h1>골프 경기력 향상 미션 솔루션</h1>
        <p>코치 / 선수로 로그인해 주세요.</p>
        <div style={{ margin: '12px 0' }}>
          <input
            style={{ width: 'calc(100% - 110px)', padding: 8 }}
            placeholder="코치 코드"
            value={coachCode}
            onChange={e => setCoachCode(e.target.value)}
          />
          <button style={{ marginLeft: 8 }} onClick={handleLoginAsCoach}>
            코치 로그인
          </button>
        </div>
        <div style={{ margin: '12px 0' }}>
          <input
            style={{ width: 'calc(100% - 110px)', padding: 8 }}
            placeholder="선수 ID"
            value={playerId}
            onChange={e => setPlayerId(e.target.value)}
          />
          <button style={{ marginLeft: 8 }} onClick={handleLoginAsPlayer}>
            선수 로그인
          </button>
        </div>
        <div style={{ marginTop: 24 }}>
          <button onClick={() => handleCreateUser('coach')}>코치 계정 생성</button>
          <button style={{ marginLeft: 8 }} onClick={() => handleCreateUser('player')}>
            선수 계정 생성 (코치 코드 필요)
          </button>
        </div>
      </div>
    );
  }

  const isCoach = role === 'coach';

  return (
    <div style={{ padding: 20, maxWidth: 960, margin: '0 auto', fontFamily: 'sans-serif' }}>
      <h1>골프 미션 풀스택 앱 (Supabase)</h1>
      <h3>안녕하세요, {isCoach ? '코치' : '선수'} ({isCoach ? currentCoach : currentPlayer})님</h3>
      <button
        onClick={() => {
          setRole(null);
          setCurrentCoach(null);
          setCurrentPlayer(null);
          setCoachCode('');
          setPlayerId('');
        }}
      >
        로그아웃
      </button>

      <hr />

      <div>
        <h3>미션 카테고리</h3>
        <button disabled={category === 'technical'} onClick={() => setCategory('technical')}>
          테크니컬 미션
        </button>
        <button disabled={category === 'game'} onClick={() => setCategory('game')} style={{ marginLeft: 8 }}>
          실전 미션
        </button>
      </div>

      <div style={{ marginTop: 16 }}>
        {subcategories[category].map(item => (
          <button
            key={item.key}
            onClick={() => setSubcategory(item.key)}
            style={{ marginRight: 8, background: subcategory === item.key ? '#3498db' : '#ddd', color: subcategory === item.key ? '#fff' : '#000' }}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div style={{ marginTop: 20 }}>
        <h3>미션 리스트</h3>
        {filteredMissions.length === 0 && <p>선택한 서브카테고리의 미션이 없습니다.</p>}
        <ul>
          {filteredMissions.map(m => (
            <li key={m.id} style={{ marginBottom: 8 }}>
              <strong>{m.title}</strong> - {m.description}
              <div style={{ color: '#666' }}>
                작성: {m.created_by} / 할당: {m.assigned_to === 'all' ? '전체' : m.assigned_to}
              </div>
            </li>
          ))}
        </ul>
      </div>

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
              {players.map(p => (
                <option key={p.id} value={p.id}>
                  선수 {p.id}
                </option>
              ))}
            </select>
          </div>
          <button onClick={handleAddMission}>미션 등록</button>
        </div>
      )}

      {!isCoach && (
        <div style={{ marginTop: 24, borderTop: '1px solid #eee', paddingTop: 12 }}>
          <h3>수행 예정 미션</h3>
          <p>미션 수행 후 결과를 기록하고 코치 피드백을 받을 수 있습니다.</p>

          {filteredMissions.map(m => (
            <div key={m.id} style={{ border: '1px solid #ccc', marginBottom: 8, padding: 8 }}>
              <strong>{m.title}</strong>
              <p>{m.description}</p>
              <textarea
                value={playerNote}
                onChange={e => setPlayerNote(e.target.value)}
                placeholder="수행 코멘트 입력"
                style={{ width: '100%', minHeight: 64, marginBottom: 8 }}
              />
              <button onClick={() => handleCompleteMission(m.id)}>완료 제출</button>
            </div>
          ))}

          <div style={{ marginTop: 24 }}>
            <h3>나의 미션 로그</h3>
            {missionLogs
              .filter(log => log.player_id === currentPlayer)
              .map(log => (
                <div key={log.id} style={{ border: '1px dashed #999', marginBottom: 8, padding: 8 }}>
                  <div>미션 ID: {log.mission_id}</div>
                  <div>상태: {log.status}</div>
                  <div>작성일: {new Date(log.created_at).toLocaleString()}</div>
                  <div>선수 메모: {log.note}</div>
                  <div>코치 피드백: {log.coach_feedback || '미등록'}</div>
                </div>
              ))}
          </div>
        </div>
      )}

      {isCoach && (
        <div style={{ marginTop: 24, borderTop: '1px solid #eee', paddingTop: 12 }}>
          <h3>코치 미션 로그 / 피드백 관리</h3>
          {missionLogs.map(log => (
            <div key={log.id} style={{ border: '1px dashed #666', marginBottom: 8, padding: 8 }}>
              <div>로그 ID: {log.id}</div>
              <div>미션 ID: {log.mission_id}</div>
              <div>선수 ID: {log.player_id}</div>
              <div>상태: {log.status}</div>
              <div>선수 코멘트: {log.note}</div>
              <div>등록 피드백: {log.coach_feedback || '없음'}</div>
              <textarea
                value={coachFeedback[log.id] || ''}
                onChange={e => setCoachFeedback(prev => ({ ...prev, [log.id]: e.target.value }))}
                placeholder="코치 코멘트를 입력하세요"
                style={{ width: '100%', minHeight: 60, marginTop: 8 }}
              />
              <button onClick={() => handleCoachFeedback(log.id)} style={{ marginTop: 4 }}>
                피드백 저장
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default App;
