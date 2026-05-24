// ─────────────────────────────────────────────────────────────────────────
// voice-runtime.js — voice.html standalone에 실제 마이크/녹음/전사/업로드 부착
// 번들러가 document.documentElement.replaceWith(...)로 DOM을 교체한 직후 호출됨.
// window는 살아남으므로 여기서 정의한 __voiceInit는 swap 후에도 호출 가능.
// ─────────────────────────────────────────────────────────────────────────
(function(){
  // ── 디버그 모드 — ?debug=1 시 화면에 mini-console 표시 ────────────────────
  // 안드로이드 Chrome 등 모바일에서 콘솔 UI 가 없어 진단이 어려움.
  // 외부 CDN(eruda 등) 의존 없이 자체 구현 — 차단/네트워크 이슈에도 무조건 동작.
  // production 영향 0 (debug=1 없으면 활성화 안 됨).
  //
  // ⚠️ voice.html 은 bundler 가 document.documentElement.replaceWith(...) 로 DOM
  // 을 통째 교체. head 시점에 box 를 body 에 붙여도 swap 으로 날아감.
  // 이를 위해 ensureMiniConsole() 헬퍼를 노출하고 __voiceInit 진입 시점에도
  // 다시 호출 — box 가 없거나 분리된 상태면 재생성.
  window._ensureMiniConsole = function(){
    if (location.search.indexOf('debug=1') < 0) return;
    if (document.getElementById('__mini_console') && document.body && document.body.contains(document.getElementById('__mini_console'))) return;
    var box = document.createElement('div');
    box.id = '__mini_console';
    box.style.cssText = 'position:fixed;bottom:0;left:0;right:0;max-height:45vh;background:rgba(0,0,0,.92);color:#9f9;font:11px ui-monospace,Menlo,monospace;overflow:auto;padding:6px 8px 30px;z-index:2147483647;border-top:2px solid #4f4;white-space:pre-wrap;word-break:break-all;';
    var close = document.createElement('button');
    close.textContent = '✕ 닫기';
    close.style.cssText = 'position:fixed;bottom:4px;right:8px;z-index:2147483647;background:#f44;color:#fff;border:none;padding:4px 10px;border-radius:4px;font-size:11px;';
    close.onclick = function(){ box.style.display='none'; close.style.display='none'; };
    var clear = document.createElement('button');
    clear.textContent = '🗑 지우기';
    clear.style.cssText = 'position:fixed;bottom:4px;right:70px;z-index:2147483647;background:#444;color:#fff;border:none;padding:4px 10px;border-radius:4px;font-size:11px;';
    clear.onclick = function(){ box.innerHTML = ''; };
    var parent = document.body || document.documentElement;
    parent.appendChild(box);
    parent.appendChild(close);
    parent.appendChild(clear);
    function fmt(a){ if(typeof a==='string')return a; try{return JSON.stringify(a);}catch(e){return String(a);} }
    function add(level, args){
      var ts = new Date().toISOString().slice(11,19);
      var line = document.createElement('div');
      line.style.cssText = 'color:'+(level==='error'?'#f88':level==='warn'?'#fc6':level==='info'?'#9cf':'#9f9')+';padding:2px 0;border-bottom:1px solid #222;';
      try { line.textContent = ts+' ['+level+'] '+Array.prototype.slice.call(args).map(fmt).join(' '); }
      catch(e){ line.textContent = ts+' ['+level+'] (fmt err)'; }
      box.appendChild(line);
      box.scrollTop = box.scrollHeight;
    }
    // console hijack — 한 번만 (이미 hijack 됐으면 skip, box 는 새로 만들었지만 add 는 closure 안에 새로 정의되므로 hijack 도 다시 걸어야 새 box 에 그림)
    ['log','warn','error','info'].forEach(function(lvl){
      var orig = window._origConsole && window._origConsole[lvl] ? window._origConsole[lvl] : console[lvl];
      window._origConsole = window._origConsole || {};
      if (!window._origConsole[lvl]) window._origConsole[lvl] = orig;
      console[lvl] = function(){ try{add(lvl,arguments);}catch(e){} if(window._origConsole[lvl]) window._origConsole[lvl].apply(console, arguments); };
    });
    if (!window._miniConsoleErrorHooked){
      window._miniConsoleErrorHooked = true;
      window.addEventListener('error', function(e){ try{add('error',[e.message, (e.filename||'')+':'+e.lineno]);}catch(_){} });
      window.addEventListener('unhandledrejection', function(e){ try{add('error',['unhandledrejection', e.reason && (e.reason.message||String(e.reason))]);}catch(_){} });
    }
    add('info', ['[mini-console] ready — debug=1 활성 (re-init OK). UA: '+(navigator.userAgent||'').slice(0,80)]);
  };
  if (location.search.indexOf('debug=1') >= 0){
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', window._ensureMiniConsole);
    else window._ensureMiniConsole();
  }

  var SUPABASE_URL = 'https://gaibakqhdfdpnsdgpmya.supabase.co';
  var SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdhaWJha3FoZGZkcG5zZGdwbXlhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ0MDQyMzEsImV4cCI6MjA4OTk4MDIzMX0.diMKgPDIcM8PsHFiq4hcVkTak5ehp57uNc4Uke1SPg8';
  var BUCKET = 'voice-recordings';

  function getUserId(){
    try { return (JSON.parse(localStorage.getItem('aiDonghang_profile')||'{}').id) || null; }
    catch(e){ return null; }
  }
  function pad2(n){ return String(n).padStart(2,'0'); }
  function fmtTime(s){ return pad2(Math.floor(s/60)) + ':' + pad2(s%60); }
  function pickMime(){
    var candidates = ['audio/webm;codecs=opus','audio/webm','audio/mp4;codecs=mp4a.40.2','audio/mp4','audio/ogg;codecs=opus'];
    for (var i=0;i<candidates.length;i++){
      if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return '';
  }

  // 토스트 — 시니어 친화 — 5초간 화면 하단 노출
  function toast(msg){
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;left:50%;bottom:32px;transform:translateX(-50%);background:rgba(28,26,23,.92);color:#FBF8F3;padding:14px 22px;border-radius:8px;font-size:15px;z-index:99999;box-shadow:0 8px 24px rgba(0,0,0,.18);max-width:90vw;text-align:center;';
    document.body.appendChild(t);
    setTimeout(function(){ if(t.parentNode) t.parentNode.removeChild(t); }, 5000);
  }

  // ─────────────────────────────────────────────────────────────
  // 동동이 페르소나 — ai-donghang.html _autobioBuildSystemPrompt 포팅.
  // 6단계 점진 심화 + 5-7회 마무리 + [INTERVIEW_END] 토큰.
  // ─────────────────────────────────────────────────────────────
  function buildSystemPrompt(sessionNumber, chapterTitle){
    var name = '';
    try { name = (JSON.parse(localStorage.getItem('aiDonghang_profile')||'{}').name) || ''; }
    catch(e){}
    if (!name) name = '어르신';
    return [
      '당신은 어르신 자서전 작가 동동이입니다.',
      '지금 ' + name + '님과 ' + (sessionNumber || 1) + '회차 인터뷰를 진행하고 있습니다.',
      '오늘의 주제: ' + (chapterTitle || '어린 시절의 풍경'),
      '',
      '【인터뷰 원칙】',
      '1. 한 번에 한 가지 질문만 (절대 2개 이상 X)',
      '2. ' + name + '님 답변에서 가장 인상적인 한 가지를 더 깊이 파고드세요',
      '3. 6단계 점진 심화: 장면(어떤 모습) → 감각(소리·냄새) → 사람(누가 함께) → 사건(어떤 일) → 감정(어떤 마음) → 의미(지금 돌아보면)',
      '4. 5-7번 질문 후 자연스럽게 "오늘은 여기까지 어떠세요?" 같이 마무리 제안',
      '5. ' + name + '님이 마무리에 동의하면 따뜻한 마지막 말 + 마지막 줄에 [INTERVIEW_END] 토큰을 출력하세요',
      '',
      '【어르신 친화 언어】',
      '- 존댓말, ' + name + '님 호칭 사용',
      '- 한 문장은 30자 이내, 짧고 명확하게',
      '- 한자어보다 순우리말',
      '- "혹시 기억나시는 게 있나요?" 같은 부드러운 표현',
      '- 답변이 짧아도 강요하지 말고, 다른 각도로 다시 묻기',
      '',
      '【절대 하지 말 것】',
      '- 복잡한 단어, 외래어',
      '- 한 번에 2개 이상 질문',
      '- 사실 확인 강요 ("정확히 몇 년도였나요?" X)',
      '- 정치·종교 같은 민감 주제 (' + name + '님이 먼저 꺼내면 OK)',
      '',
      '【출력 형식】',
      '- 인터뷰 중: 다음 질문 한 줄만 (앞말·인사 없이 바로 질문, 줄바꿈 1-2줄 OK)',
      '- 마무리 시점: 부드러운 마무리 제안',
      '- 종료 시: 따뜻한 마지막 말 후 마지막 줄에 [INTERVIEW_END] 토큰'
    ].join('\n');
  }

  // Claude API 호출 — Supabase Edge Function claude-proxy 사용.
  // ai-donghang.html의 자서전 흐름이 이미 쓰고 있는 그 endpoint. multi-turn messages
  // 그대로 지원, API 키는 함수 환경변수에만 살아 브라우저 노출 없음.
  //
  // ⚠️ 헤더는 Content-Type 만. claude-proxy 의 CORS allow-headers 는
  // "Content-Type, anthropic-version" 뿐이라 Authorization/apikey 를 넣으면
  // 브라우저 preflight 가 차단해서 fetch 가 catch 발동 → "동동이가 멍해졌어요"
  // (ai-donghang.html L11878, L12050 도 동일하게 Content-Type 만 보냄.)
  // Promise 는 {ok, text, status} 로 resolve — 호출부에서 status 별 메시지 표시.
  function callClaudeAdaptive(messages, systemPrompt){
    return new Promise(function(resolve){
      fetch(SUPABASE_URL + '/functions/v1/claude-proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 600,
          system: systemPrompt,
          messages: messages
        })
      }).then(function(res){
        if (!res.ok){
          res.text().then(function(t){
            console.warn('[voice-runtime] claude-proxy fail', res.status, t);
          });
          resolve({ ok:false, text:null, status:res.status }); return;
        }
        return res.json().then(function(d){
          var txt = ((d && d.content) || []).map(function(b){ return b.text || ''; }).join('').trim();
          resolve({ ok:!!txt, text:txt || null, status:200 });
        });
      }).catch(function(e){
        console.warn('[voice-runtime] claude-proxy err', e);
        resolve({ ok:false, text:null, status:0, err:String(e && e.message || e) });
      });
    });
  }

  // 대화 이력 localStorage — 페이지 리로드 시 복원
  var MSG_KEY = 'aiDonghang_voiceMessages';
  function loadMessages(){
    try { return JSON.parse(localStorage.getItem(MSG_KEY) || '[]'); }
    catch(e){ return []; }
  }
  function saveMessages(msgs){
    try { localStorage.setItem(MSG_KEY, JSON.stringify(msgs)); } catch(e){}
  }

  // iOS Safari 감지 — webkitSpeechRecognition 이 침묵에 매우 민감해 짧은 끊김이 잦음.
  // 시니어가 한 문장씩 천천히 말하도록 안내 한 줄을 mic 아래 표시.
  function _isIOSSafari(){
    var ua = navigator.userAgent || '';
    var isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
    var isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
    return isIOS && isSafari;
  }
  // 안드로이드 감지 — Chrome 의 webkitSpeechRecognition 이 continuous=true 를
  // 사실상 무시. 짧게 한 발화만 듣고 끊겨 텍스트가 한 번도 안 나오는 케이스 빈번.
  // continuous=false + onend 재시작 패턴으로 우회.
  function _isAndroid(){
    return /Android/i.test(navigator.userAgent || '');
  }

  window.__voiceInit = function(){
    // bundler 가 documentElement 를 swap 한 뒤이므로 미니 콘솔 박스가 사라졌을 수 있음.
    // ?debug=1 켜진 채로 진단하려면 swap 후 시점에 다시 보장.
    try { if (window._ensureMiniConsole) window._ensureMiniConsole(); } catch(e){}
    console.log('[VDBG] __voiceInit start');
    var micBtn = document.getElementById('mic-btn');
    if (!micBtn) { console.warn('[voice-runtime] mic-btn not found — bundle DOM may differ'); console.log('[VDBG] mic-btn NOT FOUND'); return; }
    console.log('[VDBG] mic-btn found');

    // 데모 핸들러 제거 — clone으로 listener 분리
    var fresh = micBtn.cloneNode(true);
    micBtn.parentNode.replaceChild(fresh, micBtn);
    micBtn = fresh;

    var body = document.body;
    var transcriptBody = document.getElementById('transcript-body');
    var timerText = document.getElementById('timer-text');
    var confirmBtn = document.getElementById('confirm-btn');
    var redoBtn = document.getElementById('redo-btn');
    var continueBtn = document.getElementById('continue-btn');
    var pauseBtn = document.getElementById('pause-btn');

    // 데모의 가짜 전사 체인(setRecording → tickHandle setInterval, DEMO_TRANSCRIPT)이
    // mic/pause/continue/redo 어느 버튼에서든 fire 되면 closure 내부 tickHandle을
    // 외부에서 멈출 수 없어 매 초 가짜 단어가 transcriptBody에 끼어 깜빡임을 만든다.
    // 안전한 유일한 길은 setRecording을 호출할 수 있는 모든 버튼을 cloneNode 로
    // 떼버려서 데모 listener를 완전히 제거하는 것.
    function takeOver(el){
      if (!el) return null;
      var fresh = el.cloneNode(true);
      el.parentNode.replaceChild(fresh, el);
      return fresh;
    }
    pauseBtn = takeOver(pauseBtn);
    continueBtn = takeOver(continueBtn);
    redoBtn = takeOver(redoBtn);   // setRecording(false)로 typewriter 시작 → 제거
    // confirmBtn 도 clone — 데모의 "다음 질문 시뮬레이션" 토스트와 내 진짜 진행 흐름이
    // 경쟁하지 않도록 완전 인수. 진행 UI(processing 상태)는 내가 직접 처리.
    confirmBtn = takeOver(confirmBtn);

    var mediaRec = null, audioChunks = [], mimeType = '';
    var speechRec = null, baseFinal = '', lastFinalIdx = -1, lastFullFinal = '';
    var srIntent = false, srRestarts = [];
    var secTimer = null, seconds = 0;
    var lastUploadedUrl = null;
    var messages = loadMessages();       // 누적 대화 이력 (Claude messages 형식)
    var interviewEnded = false;          // [INTERVIEW_END] 토큰 도달 후 잠금

    // ── 안드로이드 STT 전략 (2026-05-24 Deepgram WebSocket streaming) ─────
    // 배경: 안드로이드 Chrome 은 webkitSR + MediaRecorder 동시 마이크 점유 불가.
    // 이전 시도: Vosk(부정확) → CLOVA(유료) → Groq(file-based, 실시간 미리보기 X).
    // 사용자 요구 명확: 실시간 미리보기 + 녹음 둘 다.
    // 최종 선택: Deepgram Nova-3 WebSocket streaming —
    //   - 마이크 access 1회로 stream 공유 (MediaRecorder + AudioContext/ScriptProcessor)
    //   - WebSocket 으로 PCM 청크 push → interim/final 결과 push 받음 (~300ms 지연)
    //   - $200 무료 크레딧 (≈770시간) — 카드 등록 X
    //   - 한국어 정확도 webkitSR/Whisper 수준
    //   - access_token 은 deepgram-token Edge Function 이 60초 단명 token 발급
    //     (API 키 클라이언트 노출 X)
    var DEEPGRAM_TOKEN_URL = SUPABASE_URL + '/functions/v1/deepgram-token';
    var dgWs = null;
    var dgAudioCtx = null;
    var dgSource = null;
    var dgProcessor = null;
    var dgStream = null;
    var dgInterim = '';            // 직전 interim — final 도착 시 화면 갱신용
    var androidStarting = false;   // mic 다중 클릭 차단

    // 질문 영역 DOM
    var questionTextEl = document.querySelector('.question-text');
    var questionEyebrowEl = document.querySelector('.question-eyebrow');
    var progressTextEl = document.querySelector('.progress-text');

    // 마지막 동동이 메시지(또는 voice.html 초기 질문)를 화면에 그림
    function renderCurrentQuestion(){
      var assistantTurns = messages.filter(function(m){ return m.role === 'assistant'; });
      var current;
      if (assistantTurns.length){
        // [INTERVIEW_END] 토큰을 제거하고 표시
        current = assistantTurns[assistantTurns.length-1].content.replace(/\[INTERVIEW_END\]\s*$/,'').trim();
      } else if (questionTextEl){
        // 첫 진입 — voice.html 데모의 초기 질문을 그대로 첫 질문으로 채택
        // innerText는 <br>을 \n으로 보존; textContent는 붙여버려서 의미 깨짐
        current = (questionTextEl.innerText || questionTextEl.textContent || '').trim();
        // 첫 질문을 assistant 메시지로 저장 (이후 대화 컨텍스트에 포함)
        if (current){
          messages.push({ role: 'assistant', content: current, at: new Date().toISOString() });
          saveMessages(messages);
        }
      }
      if (questionTextEl && current){
        // <br>로 줄바꿈 처리 (질문에 \n 있으면 시각적으로 두 줄)
        questionTextEl.innerHTML = current.split('\n').map(function(s){
          return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        }).join('<br>');
      }
      // 진행 표시: 답변 횟수 기준 (사용자 메시지 + 1)
      var userTurns = messages.filter(function(m){ return m.role === 'user'; }).length;
      var qN = userTurns + 1;
      if (progressTextEl) progressTextEl.textContent = '질문 ' + qN;
    }
    renderCurrentQuestion();

    function setTranscriptText(txt){
      if (!transcriptBody) return;
      // 데모의 placeholder(.ph) 제거
      var ph = transcriptBody.querySelector('.ph');
      if (ph) ph.remove();
      transcriptBody.textContent = txt;
    }

    function getRecognitionCtor(){
      return window.SpeechRecognition || window.webkitSpeechRecognition || null;
    }

    function buildAndStartSR(initialBase){
      var SR = getRecognitionCtor();
      if (!SR) { console.log('[VDBG] buildAndStartSR: NO SR ctor'); return null; }
      var rec;
      try { rec = new SR(); } catch(e){ console.log('[VDBG] SR ctor FAIL ' + e); console.warn('[voice-runtime] SR ctor', e); return null; }
      rec.lang = 'ko-KR';
      // Android Chrome 은 continuous=true 무시 + 짧은 첫 발화만 듣고 종료해
      // onresult 자체가 안 와서 텍스트 변환이 한 번도 안 되는 사용자 보고.
      // false 로 시작하고 onend 에서 재시작하는 패턴으로 강제 chunked 처리.
      rec.continuous = !_isAndroid();
      rec.interimResults = true;
      console.log('[VDBG] buildAndStartSR continuous=' + rec.continuous + ' interim=' + rec.interimResults);

      var instanceBase = (initialBase != null) ? initialBase : baseFinal;
      var localLastFinalIdx = -1;

      rec.onresult = function(ev){
        console.log('[VDBG] onresult len=' + (ev.results ? ev.results.length : 0) + ' idx=' + ev.resultIndex);
        var interim = '', addedFinal = '';
        for (var i = ev.resultIndex; i < ev.results.length; i++){
          var t = (ev.results[i][0] && ev.results[i][0].transcript) || '';
          if (ev.results[i].isFinal){
            if (i <= localLastFinalIdx) continue;
            localLastFinalIdx = i;
            var trimmed = t.trim();
            if (!trimmed) continue;
            // Galaxy 누적 final 패턴 — 새 final이 직전 누적의 superset이면 suffix만
            var newPortion;
            if (lastFullFinal && trimmed.indexOf(lastFullFinal) === 0){
              newPortion = trimmed.substring(lastFullFinal.length).replace(/^\s+/, '');
            } else if (lastFullFinal && lastFullFinal.indexOf(trimmed) === 0){
              continue;
            } else if (trimmed === lastFullFinal){
              continue;
            } else {
              newPortion = trimmed;
            }
            if (!newPortion) continue;
            addedFinal += newPortion + ' ';
            lastFullFinal = trimmed;
          } else {
            interim += t;
          }
        }
        if (addedFinal){
          baseFinal = (baseFinal + (baseFinal ? ' ' : '') + addedFinal).trim();
          instanceBase = baseFinal;
        }
        var display = (baseFinal + (baseFinal && interim ? ' ' : '') + interim).trim();
        setTranscriptText(display || '');
      };

      rec.onerror = function(e){
        var err = e && e.error;
        console.log('[VDBG] onerror=' + err);
        console.warn('[voice-runtime] SR err', err);
        if (err === 'not-allowed' || err === 'service-not-allowed'){
          toast('마이크 권한이 거부됐어요. 브라우저 설정에서 허용해주세요 🙏');
          stopRecording();
        }
        // 그 외 (no-speech, aborted, network)는 onend에서 재시작 처리
      };

      rec.onend = function(){
        console.log('[VDBG] onend intent=' + srIntent + ' sameRec=' + (speechRec===rec) + ' restarts=' + srRestarts.length);
        if (!srIntent) return;
        if (speechRec !== rec) return;
        var now = Date.now();
        // 20초 윈도우, 10회까지 재시작 허용. iOS Safari가 침묵에 매우 민감해서
        // 짧은 간격으로 onend 가 자주 발생 — 기존 6회/10초는 너무 빡빡해 시니어가
        // 잠깐 숨 고르는 사이에 STT가 통째로 죽어버림.
        srRestarts = srRestarts.filter(function(t){ return now - t < 20000; });
        if (srRestarts.length >= 10){
          console.warn('[voice-runtime] SR too many restarts (' + srRestarts.length + ' in 20s) — give up STT but keep MediaRecorder running. baseFinal so far:', baseFinal);
          speechRec = null;
          toast('말씀이 잘 안 들렸어요. 마이크 다시 눌러주세요 🙏');
          return;
        }
        srRestarts.push(now);
        speechRec = null;
        // backoff 헬퍼로 재시작 — 한 번 실패해도 500/1000/2000ms 단계로 재시도.
        // Galaxy 오디오 세션 release 가 350ms 로 부족한 케이스 대응.
        _startSRWithBackoff(0, baseFinal);
      };

      try { rec.start(); console.log('[VDBG] rec.start() OK'); return rec; }
      catch(e){ console.log('[VDBG] rec.start() FAIL ' + (e && e.message || e)); console.warn('[voice-runtime] SR start', e); return null; }
    }

    // SR 시작 backoff 체인 — Galaxy/안드로이드 첫 시도 InvalidStateError 대비.
    // [0, 500, 1000, 2000]ms 순으로 buildAndStartSR 재시도. 성공하면 speechRec
    // 셋. 모든 시도 실패하면 STT 포기하고 사용자에게 안내(MediaRecorder 는
    // 계속 돌아 음성 파일은 저장됨).
    function _startSRWithBackoff(attempt, base){
      attempt = attempt || 0;
      var delays = [0, 500, 1000, 2000];
      if (attempt >= delays.length){
        console.warn('[voice-runtime] SR backoff 모두 실패 — MediaRecorder 만 진행');
        speechRec = null;
        toast('음성 인식이 시작되지 않았어요. 마이크 권한을 확인해 주세요 🙏');
        return;
      }
      setTimeout(function(){
        if (!srIntent) return;
        if (speechRec) return; // 이미 누가 셋팅했으면 패스
        var fresh = buildAndStartSR(base != null ? base : baseFinal);
        if (fresh){
          speechRec = fresh;
          if (attempt > 0) console.log('[voice-runtime] SR start 재시도 #' + attempt + ' 성공');
        } else {
          _startSRWithBackoff(attempt + 1, base);
        }
      }, delays[attempt]);
    }

    // opts.append === true 면 기존 baseFinal/audioChunks/timer 누적 (이어서 말하기)
    function startRecording(opts){
      var append = !!(opts && opts.append);
      console.log('[VDBG] startRecording append=' + append + ' hasMD=' + !!navigator.mediaDevices);

      // ── 안드로이드 Chrome 우회: Deepgram WebSocket 실시간 streaming
      //    같은 stream 으로 MediaRecorder(녹음) + AudioContext/ScriptProcessor(PCM
      //    추출 → ws.send) 공존. Deepgram interim/final push → 실시간 미리보기.
      if (_isAndroid()){
        console.log('[VDBG] Android — Deepgram WebSocket streaming mode');
        if (speechRec){ try { speechRec.stop(); } catch(e){} speechRec = null; }
        androidStarting = true;
        _startAndroidDeepgram(append).then(function(){
          androidStarting = false;
        }).catch(function(err){
          androidStarting = false;
          console.log('[VDBG] Android Deepgram start FAIL ' + (err && err.message || err));
          toast('음성 인식을 시작할 수 없어요. 잠시 후 다시 시도해 주세요 🙏');
        });
        return;
      }

      // ── 비안드로이드 (iOS / 데스크탑): 기존 흐름 — getUserMedia + MediaRecorder + SR
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
        console.log('[VDBG] no mediaDevices');
        toast('이 브라우저는 마이크 사용을 지원하지 않아요 🙏');
        return;
      }
      // 이전 SR 잔재 정리 — stopRecording 누락/race 대비 이중 안전.
      if (speechRec){
        try { speechRec.stop(); } catch(e){}
        speechRec = null;
      }
      console.log('[VDBG] getUserMedia call');
      navigator.mediaDevices.getUserMedia({ audio: true }).then(function(stream){
        console.log('[VDBG] getUserMedia OK, stream tracks=' + stream.getAudioTracks().length);
        if (!append){
          audioChunks = [];
          baseFinal = '';
          seconds = 0;
          if (timerText) timerText.textContent = fmtTime(0);
          if (transcriptBody){
            var ph = transcriptBody.querySelector('.ph');
            if (ph) ph.remove();
            transcriptBody.textContent = '';
          }
        } else {
          // 이어서 — 데모가 placeholder를 다시 깔았으면 제거, 기존 baseFinal 다시 그려줌
          if (transcriptBody){
            var ph2 = transcriptBody.querySelector('.ph');
            if (ph2) ph2.remove();
            if (baseFinal) transcriptBody.textContent = baseFinal;
          }
        }
        mimeType = pickMime();
        try {
          mediaRec = mimeType ? new MediaRecorder(stream, { mimeType: mimeType })
                              : new MediaRecorder(stream);
        } catch(e){
          console.warn('[voice-runtime] MR ctor', e);
          mediaRec = new MediaRecorder(stream);
        }
        mediaRec.ondataavailable = function(e){
          if (e.data && e.data.size > 0) audioChunks.push(e.data);
        };
        mediaRec.start(1000); // 1초마다 chunk — 이어말하기 시 새 stream의 chunk가 같은 array에 누적

        // STT — 새 인스턴스, baseFinal을 base로 넘김
        // Galaxy/안드로이드 Chrome: 첫 SR.start() 가 InvalidStateError 빈번 —
        // 오디오 세션 release 미완료 또는 마이크 권한 dialog 와 충돌. backoff
        // 체인으로 [0, 500, 1000, 2000]ms 재시도. (ai-donghang.html L91e41f4
        // 의 _autobioScheduleRestart 패턴을 voice-runtime 에도 포팅)
        lastFullFinal = ''; // 새 SR 세션 — Galaxy dedup state 초기화
        srRestarts = [];
        srIntent = true;
        console.log('[VDBG] _startSRWithBackoff(0) call');
        _startSRWithBackoff(0, baseFinal);

        body.classList.remove('is-reviewing');
        body.classList.add('is-recording');
        clearInterval(secTimer);
        secTimer = setInterval(function(){
          seconds++;
          if (timerText) timerText.textContent = fmtTime(seconds);
        }, 1000);
      }).catch(function(err){
        console.log('[VDBG] getUserMedia FAIL name=' + (err && err.name) + ' msg=' + (err && err.message));
        console.warn('[voice-runtime] getUserMedia', err);
        if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')){
          toast('마이크 권한이 거부됐어요. 주소창 자물쇠 → 마이크 허용으로 바꿔주세요 🙏');
        } else if (err && err.name === 'NotFoundError'){
          toast('마이크를 찾을 수 없어요. 이어폰/헤드셋이 잘 연결됐는지 확인해 주세요 🙏');
        } else {
          toast('마이크를 켤 수 없어요. 잠시 후 다시 시도해 주세요 🙏');
        }
      });
    }

    function stopRecording(){
      srIntent = false;
      clearInterval(secTimer);
      try { if (speechRec) speechRec.stop(); } catch(e){}
      // ★ null 처리 필수 — 안 하면 "잠시 멈추기" 후 "이어서 말씀하기" 클릭 시
      // _startSRWithBackoff 안의 `if(speechRec) return` 가드에 걸려 새 SR 안
      // 시작됨 (iPhone 보고된 증상). startRecording 도 진입 시 또 정리.
      speechRec = null;
      try { if (mediaRec && mediaRec.state !== 'inactive') mediaRec.stop(); } catch(e){}
      if (mediaRec && mediaRec.stream){
        try { mediaRec.stream.getTracks().forEach(function(t){ t.stop(); }); } catch(e){}
      }
      body.classList.remove('is-recording');
      body.classList.add('is-reviewing');

      // 안드로이드 — Deepgram WebSocket 파이프라인 정리 (CloseStream + 자원 해제).
      // baseFinal/transcriptBody 는 streaming 중 이미 누적됐음.
      // (iOS / 데스크탑은 webkitSR 가 실시간으로 이미 baseFinal 누적했음.)
      if (_isAndroid()){
        _teardownAndroidDeepgram();
      }
    }

    function uploadAudio(){
      return new Promise(function(resolve){
        if (!audioChunks.length){ resolve(null); return; }
        var type = (mediaRec && mediaRec.mimeType) || mimeType || 'audio/webm';
        var blob = new Blob(audioChunks, { type: type });
        var ext = type.indexOf('mp4') >= 0 ? 'm4a' :
                  type.indexOf('ogg') >= 0 ? 'ogg' : 'webm';
        var uid = getUserId() || 'anon';
        var path = uid + '/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext;
        fetch(SUPABASE_URL + '/storage/v1/object/' + BUCKET + '/' + path, {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + SUPABASE_KEY,
            'apikey': SUPABASE_KEY,
            'Content-Type': blob.type,
            'x-upsert': 'true'
          },
          body: blob
        }).then(function(res){
          if (!res.ok){
            res.text().then(function(t){ console.warn('[voice-runtime] upload fail', res.status, t); });
            resolve(null); return;
          }
          var url = SUPABASE_URL + '/storage/v1/object/public/' + BUCKET + '/' + path;
          lastUploadedUrl = url;
          console.log('[voice-runtime] uploaded', url);
          resolve(url);
        }).catch(function(e){
          console.warn('[voice-runtime] upload err', e);
          resolve(null);
        });
      });
    }

    // ── 안드로이드 Deepgram WebSocket streaming 시작 ───────────────────────
    // 흐름:
    //   1) deepgram-token 호출해 60초 단명 access_token 받기
    //   2) getUserMedia → stream 1개
    //   3) AudioContext + ScriptProcessor 로 PCM 추출 → ws.send
    //   4) MediaRecorder 로 같은 stream 녹음 → audioChunks
    //   5) ws.onmessage 로 interim/final 받아 transcriptBody/baseFinal 갱신
    function _startAndroidDeepgram(append){
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
        return Promise.reject(new Error('no mediaDevices'));
      }
      if (!append){
        audioChunks = [];
        baseFinal = '';
        seconds = 0;
        if (timerText) timerText.textContent = fmtTime(0);
        if (transcriptBody){
          var phA = transcriptBody.querySelector('.ph');
          if (phA) phA.remove();
          transcriptBody.textContent = '';
        }
      } else {
        if (transcriptBody){
          var phA2 = transcriptBody.querySelector('.ph');
          if (phA2) phA2.remove();
          if (baseFinal) transcriptBody.textContent = baseFinal;
        }
      }
      dgInterim = '';

      // 1) 단명 access_token 받기
      console.log('[VDBG] Android Deepgram — fetching token');
      return fetch(DEEPGRAM_TOKEN_URL).then(function(res){
        return res.json();
      }).then(function(tokenData){
        if (!tokenData || !tokenData.ok || !tokenData.access_token){
          throw new Error('token fail: ' + JSON.stringify(tokenData).slice(0, 200));
        }
        console.log('[VDBG] Deepgram token OK expires_in=' + tokenData.expires_in);

        // 2) getUserMedia
        return navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true }
        }).then(function(stream){
          dgStream = stream;
          console.log('[VDBG] Android stream OK tracks=' + stream.getAudioTracks().length);

          // 3) AudioContext + ScriptProcessor — PCM 캡처
          dgAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
          var sampleRate = dgAudioCtx.sampleRate;
          console.log('[VDBG] AudioContext sampleRate=' + sampleRate);

          // 4) WebSocket 연결 — encoding=linear16 + 실제 sample_rate 전달
          //    Sec-WebSocket-Protocol 로 인증 (브라우저는 custom header 못 보냄)
          var wsUrl = 'wss://api.deepgram.com/v1/listen' +
            '?model=nova-3' +
            '&language=ko' +
            '&interim_results=true' +
            '&smart_format=true' +
            '&encoding=linear16' +
            '&sample_rate=' + sampleRate +
            '&channels=1' +
            '&endpointing=300';
          dgWs = new WebSocket(wsUrl, ['token', tokenData.access_token]);
          dgWs.binaryType = 'arraybuffer';

          dgWs.onopen = function(){
            console.log('[VDBG] Deepgram WS open');
          };
          dgWs.onerror = function(e){
            console.warn('[voice-runtime] Deepgram WS error', e);
          };
          dgWs.onclose = function(e){
            console.log('[VDBG] Deepgram WS close code=' + e.code);
          };

          dgWs.onmessage = function(ev){
            var msg;
            try { msg = JSON.parse(ev.data); } catch(e){ return; }
            if (!msg || msg.type !== 'Results') return;
            var alt = msg.channel && msg.channel.alternatives && msg.channel.alternatives[0];
            if (!alt) return;
            var transcript = (alt.transcript || '').trim();
            if (msg.is_final){
              if (transcript){
                baseFinal = (baseFinal + (baseFinal ? ' ' : '') + transcript).trim();
                console.log('[VDBG] Deepgram final + "' + transcript + '"');
              }
              dgInterim = '';
              if (transcriptBody){
                var phF = transcriptBody.querySelector && transcriptBody.querySelector('.ph');
                if (phF) phF.remove();
                transcriptBody.textContent = baseFinal;
              }
            } else {
              dgInterim = transcript;
              if (transcriptBody){
                var phI = transcriptBody.querySelector && transcriptBody.querySelector('.ph');
                if (phI) phI.remove();
                transcriptBody.textContent = (baseFinal + (baseFinal && transcript ? ' ' : '') + transcript).trim();
              }
            }
          };

          // 5) ScriptProcessor — Float32 → Int16 PCM → ws.send
          dgSource = dgAudioCtx.createMediaStreamSource(stream);
          dgProcessor = dgAudioCtx.createScriptProcessor(4096, 1, 1);
          dgProcessor.onaudioprocess = function(ev){
            if (!dgWs || dgWs.readyState !== WebSocket.OPEN) return;
            var input = ev.inputBuffer.getChannelData(0);
            var pcm = new Int16Array(input.length);
            for (var i = 0; i < input.length; i++){
              var s = input[i];
              if (s > 1) s = 1; else if (s < -1) s = -1;
              pcm[i] = s < 0 ? (s * 0x8000) | 0 : (s * 0x7FFF) | 0;
            }
            try { dgWs.send(pcm.buffer); } catch(e){}
          };
          dgSource.connect(dgProcessor);
          dgProcessor.connect(dgAudioCtx.destination);
          console.log('[VDBG] Deepgram pipeline wired');

          // 6) MediaRecorder — 같은 stream 으로 녹음 파일 생성
          mimeType = pickMime();
          try {
            mediaRec = mimeType ? new MediaRecorder(stream, { mimeType: mimeType })
                                : new MediaRecorder(stream);
          } catch(e){
            console.log('[VDBG] MR ctor FAIL ' + e + ' — fallback no-mime');
            mediaRec = new MediaRecorder(stream);
          }
          mediaRec.ondataavailable = function(e){
            if (e.data && e.data.size > 0) audioChunks.push(e.data);
          };
          mediaRec.start(1000);
          console.log('[VDBG] Android MR.start() OK');

          // 7) UI
          body.classList.remove('is-reviewing');
          body.classList.add('is-recording');
          clearInterval(secTimer);
          secTimer = setInterval(function(){
            seconds++;
            if (timerText) timerText.textContent = fmtTime(seconds);
          }, 1000);
        });
      });
    }

    // Deepgram 파이프라인 정리 — stopRecording 에서 호출
    function _teardownAndroidDeepgram(){
      // CloseStream 메시지 보내 마지막 final 결과 받기
      if (dgWs && dgWs.readyState === WebSocket.OPEN){
        try { dgWs.send(JSON.stringify({ type: 'CloseStream' })); } catch(e){}
      }
      try { if (dgProcessor) dgProcessor.disconnect(); } catch(e){}
      try { if (dgSource) dgSource.disconnect(); } catch(e){}
      try { if (dgAudioCtx && dgAudioCtx.state !== 'closed') dgAudioCtx.close(); } catch(e){}
      // ws.close 는 약간 지연 — CloseStream 처리 시간 확보
      var wsToClose = dgWs;
      if (wsToClose){
        setTimeout(function(){ try { wsToClose.close(); } catch(e){} }, 500);
      }
      dgWs = null;
      dgProcessor = null;
      dgSource = null;
      dgAudioCtx = null;
      dgStream = null;
      dgInterim = '';
    }

    // ── mic 버튼 토글: 녹음 중이면 정지(검토 진입), 아니면 새로 시작
    //    검토 상태에서 mic 다시 누르면 "이어서" 가 아니라 "새로 시작" — 사용자 의도가
    //    명확한 mic 아이콘 클릭은 fresh start 로 처리. 이어서 말하려면 continueBtn 사용.
    micBtn.addEventListener('click', function(){
      console.log('[VDBG] mic-click recording=' + body.classList.contains('is-recording') + ' isAndroid=' + _isAndroid() + ' starting=' + androidStarting);
      // 안드로이드 Deepgram 시작 중 다중 클릭 차단
      if (androidStarting){
        toast('음성 인식 준비 중이에요… 잠시만요 🙏');
        return;
      }
      if (body.classList.contains('is-recording')) stopRecording();
      else startRecording({ append: false });
    });

    // ── 잠깐 멈추기 — 현재 녹음을 정지하지만 baseFinal/audioChunks 는 유지 (검토 상태)
    if (pauseBtn){
      pauseBtn.addEventListener('click', function(){
        if (body.classList.contains('is-recording')) stopRecording();
      });
    }

    // ── 이어서 말씀하기 — 기존 baseFinal/audioChunks 누적한 채로 재개 (append)
    if (continueBtn){
      continueBtn.addEventListener('click', function(){
        startRecording({ append: true });
      });
    }

    // ── 다시 답하기 — 전부 폐기하고 idle UI 로
    //    데모 redo 핸들러를 clone으로 제거했으므로 body 클래스/placeholder 까지 직접 복구
    if (redoBtn){
      redoBtn.addEventListener('click', function(){
        // 진행 중 녹음이 남아있으면 정지 + 자원 해제
        srIntent = false;
        clearInterval(secTimer);
        try { if (speechRec) speechRec.stop(); } catch(e){}
        try { if (mediaRec && mediaRec.state !== 'inactive') mediaRec.stop(); } catch(e){}
        if (mediaRec && mediaRec.stream){
          try { mediaRec.stream.getTracks().forEach(function(t){ t.stop(); }); } catch(e){}
        }
        audioChunks = [];
        baseFinal = '';
        lastFullFinal = '';
        lastUploadedUrl = null;
        seconds = 0;
        _shortConfirmShown = false;
        if (timerText) timerText.textContent = fmtTime(0);
        if (transcriptBody){
          transcriptBody.innerHTML = '<span class="ph">말씀하시면 여기에 글자로 옮겨 드립니다.</span>';
        }
        body.classList.remove('is-recording', 'is-reviewing');
      });
    }

    // ── 확인(다음) 버튼 — 업로드 + Claude 적응형 다음 질문 생성 + UI 진행
    function setProcessing(on){
      if (!confirmBtn) return;
      confirmBtn.disabled = !!on;
      var label = confirmBtn.querySelector('span');
      if (label) label.textContent = on ? '다음 질문을 만들고 있어요…' : '좋습니다, 다음으로';
    }
    function showInterviewEnd(closingWord){
      interviewEnded = true;
      var cleaned = (closingWord || '').replace(/\[INTERVIEW_END\]\s*$/,'').trim();
      if (questionEyebrowEl) questionEyebrowEl.textContent = '오늘은 여기까지';
      if (questionTextEl){
        questionTextEl.innerHTML = (cleaned || '오늘 들려주신 이야기, 정성껏 잘 담아 두었어요.')
          .split('\n').map(function(s){
            return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
          }).join('<br>');
      }
      // 다음 단계 안내 — 작품함/홈으로 돌아가기
      if (confirmBtn){
        confirmBtn.disabled = false;
        var span = confirmBtn.querySelector('span');
        if (span) span.textContent = '홈으로 돌아가기';
        confirmBtn.onclick = function(){ location.href = '/'; };
      }
      toast('오늘의 이야기 한 회차가 완성됐어요 🌿');
    }
    // 짧은 STT 결과 한 번 더 확인 — "다음" 두 번 누르면 통과
    var _shortConfirmShown = false;
    if (confirmBtn){
      confirmBtn.addEventListener('click', function(){
        if (interviewEnded) return;
        if (!baseFinal && !audioChunks.length){
          toast('아직 답변이 비어 있어요. 마이크 버튼을 눌러 한 말씀 들려주세요 🙏');
          return;
        }
        // STT 결과가 너무 짧으면 (5자 미만, 공백 제외) → 잘못 들었을 가능성 큼.
        // 음성은 녹음됐어도 텍스트가 비어/짧으면 동동이 답변이 엉뚱해질 수 있어 한 번 더 묻기.
        var stripped = (baseFinal || '').replace(/\s+/g, '');
        if (stripped.length > 0 && stripped.length < 5 && !_shortConfirmShown){
          _shortConfirmShown = true;
          toast('음성이 짧게 들렸어요. 다시 말씀하시려면 "다시 답하기", 그대로 보내시려면 "다음으로"를 한 번 더 눌러주세요 🙏');
          return;
        }
        _shortConfirmShown = false;
        setProcessing(true);
        // 1) 어르신 답변 메시지에 추가 (audio_url 은 업로드 후 채움)
        var userMsg = {
          role: 'user',
          content: baseFinal || '(음성만 기록됨)',
          at: new Date().toISOString()
        };
        messages.push(userMsg);
        saveMessages(messages);

        // 2) 오디오 업로드 (비동기 — Claude 호출과 병렬)
        var uploadP = uploadAudio().then(function(url){
          if (url){
            userMsg.audio_url = url;
            saveMessages(messages);
          }
          return url;
        });

        // 3) Claude 적응형 다음 질문 호출
        var sessionN = 1;
        var systemPrompt = buildSystemPrompt(sessionN, '어린 시절의 풍경');
        var apiMessages = messages.map(function(m){ return { role: m.role, content: m.content }; });
        var claudeP = callClaudeAdaptive(apiMessages, systemPrompt);

        Promise.all([uploadP, claudeP]).then(function(arr){
          var claudeRes = arr[1] || {};
          var nextQ = claudeRes.text;
          if (!nextQ){
            // status 코드 별 안내 — 시니어는 의미 모르지만, 개발자 콘솔 + CS 통해 진단 가능
            var hint = '';
            if (claudeRes.status === 0) hint = ' (인터넷 연결 확인)';
            else if (claudeRes.status === 401 || claudeRes.status === 403) hint = ' (코드:' + claudeRes.status + ' 인증)';
            else if (claudeRes.status >= 500) hint = ' (코드:' + claudeRes.status + ' 서버)';
            else if (claudeRes.status) hint = ' (코드:' + claudeRes.status + ')';
            toast('동동이가 잠시 멍해졌어요. 잠깐 후 다시 눌러주세요 🙏' + hint);
            setProcessing(false);
            // 실패 시 마지막 user 메시지 롤백 (다시 보내기 위해)
            messages.pop();
            saveMessages(messages);
            return;
          }
          // 4) 다음 질문 저장
          messages.push({ role: 'assistant', content: nextQ, at: new Date().toISOString() });
          saveMessages(messages);

          // 5) [INTERVIEW_END] 토큰 감지
          if (/\[INTERVIEW_END\]/.test(nextQ)){
            showInterviewEnd(nextQ);
            return;
          }

          // 6) UI 갱신 — 다음 질문 표시 + idle 상태로
          renderCurrentQuestion();
          audioChunks = [];
          baseFinal = '';
          lastFullFinal = '';
          lastUploadedUrl = null;
          seconds = 0;
          if (timerText) timerText.textContent = fmtTime(0);
          if (transcriptBody){
            transcriptBody.innerHTML = '<span class="ph">말씀하시면 여기에 글자로 옮겨 드립니다.</span>';
          }
          body.classList.remove('is-recording', 'is-reviewing');
          setProcessing(false);
        }).catch(function(e){
          console.warn('[voice-runtime] confirm flow', e);
          toast('잠시 연결이 불안정해요. 잠깐 후 다시 시도해 주세요 🙏');
          setProcessing(false);
        });
      });
    }

    // ── "이 질문은 건너뛰기" 버튼 ──────────────────────────────────────────────
    // voice.html demo 템플릿에 "이 질문은 건너뛰기" 버튼이 있는데 id 가 없고
    // demo 핸들러도 없어 클릭해도 아무 일 안 일어남. 텍스트로 버튼 찾아서
    // confirm 흐름 재사용 — baseFinal 을 메타 메시지로 채우고 confirmBtn.click()
    // 호출하면 기존 핸들러가 다음 질문을 받아옴.
    var skipBtn = null;
    var _allBtns = document.querySelectorAll('button');
    for (var _i = 0; _i < _allBtns.length; _i++){
      var _txt = (_allBtns[_i].textContent || '').trim();
      if (_txt.indexOf('건너뛰기') >= 0 && _txt.indexOf('질문') >= 0){
        skipBtn = _allBtns[_i]; break;
      }
    }
    if (skipBtn){
      skipBtn = takeOver(skipBtn);
      skipBtn.addEventListener('click', function(){
        if (interviewEnded) return;
        // 녹음 중이면 정지
        if (body.classList.contains('is-recording')) stopRecording();
        // 메타 메시지로 답변 채워서 Claude 가 다른 각도로 질문하도록 유도
        baseFinal = '(이 질문은 건너뛰고 싶어요. 다른 질문 부탁드립니다.)';
        audioChunks = [];
        _shortConfirmShown = true; // 짧은 답변 경고 우회
        if (confirmBtn) confirmBtn.click();
      });
    }

    // iOS Safari 감지 → mic 버튼 아래에 한 줄 안내 (한 번만)
    if (_isIOSSafari() && !document.getElementById('voice-ios-hint')){
      var hint = document.createElement('div');
      hint.id = 'voice-ios-hint';
      hint.textContent = '한 번에 한 문장씩, 천천히 말씀해주세요 🙂';
      hint.style.cssText = 'text-align:center;font-size:13px;color:#5C5A54;margin-top:10px;padding:0 16px;line-height:1.6;';
      // mic 버튼 직후 위치에 삽입 — DOM 구조가 번들마다 다를 수 있어 가까운 부모에 부착
      var anchor = micBtn.parentElement;
      if (anchor && anchor.parentElement){
        anchor.parentElement.insertBefore(hint, anchor.nextSibling);
      } else if (anchor){
        anchor.appendChild(hint);
      }
    }

    // 첫 진입 시점에 [INTERVIEW_END] 가 마지막 assistant 메시지에 이미 있다면
    // 이어서 새 회차로 가야 함 — 일단 종료 화면을 보여주는 게 안전
    var lastAssist = messages.filter(function(m){ return m.role === 'assistant'; }).pop();
    if (lastAssist && /\[INTERVIEW_END\]/.test(lastAssist.content)){
      showInterviewEnd(lastAssist.content);
    }

    console.log('[voice-runtime] wired — mic/STT/Supabase + adaptive Claude ready (messages:', messages.length, ', iOSSafari:', _isIOSSafari(), ')');
  };
})();
