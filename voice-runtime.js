// ─────────────────────────────────────────────────────────────────────────
// voice-runtime.js — voice.html standalone에 실제 마이크/녹음/전사/업로드 부착
// 번들러가 document.documentElement.replaceWith(...)로 DOM을 교체한 직후 호출됨.
// window는 살아남으므로 여기서 정의한 __voiceInit는 swap 후에도 호출 가능.
// ─────────────────────────────────────────────────────────────────────────
(function(){
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

  window.__voiceInit = function(){
    var micBtn = document.getElementById('mic-btn');
    if (!micBtn) { console.warn('[voice-runtime] mic-btn not found — bundle DOM may differ'); return; }

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

    var mediaRec = null, audioChunks = [], mimeType = '';
    var speechRec = null, baseFinal = '', lastFinalIdx = -1, lastFullFinal = '';
    var srIntent = false, srRestarts = [];
    var secTimer = null, seconds = 0;
    var lastUploadedUrl = null;

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
      if (!SR) return null;
      var rec;
      try { rec = new SR(); } catch(e){ console.warn('[voice-runtime] SR ctor', e); return null; }
      rec.lang = 'ko-KR';
      rec.continuous = true;
      rec.interimResults = true;

      var instanceBase = (initialBase != null) ? initialBase : baseFinal;
      var localLastFinalIdx = -1;

      rec.onresult = function(ev){
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
        console.warn('[voice-runtime] SR err', err);
        if (err === 'not-allowed' || err === 'service-not-allowed'){
          toast('마이크 권한이 거부됐어요. 브라우저 설정에서 허용해주세요 🙏');
          stopRecording();
        }
        // 그 외 (no-speech, aborted, network)는 onend에서 재시작 처리
      };

      rec.onend = function(){
        if (!srIntent) return;
        if (speechRec !== rec) return;
        var now = Date.now();
        srRestarts = srRestarts.filter(function(t){ return now - t < 10000; });
        if (srRestarts.length >= 6){
          console.warn('[voice-runtime] SR too many restarts — give up STT but keep MediaRecorder running');
          speechRec = null;
          return;
        }
        srRestarts.push(now);
        speechRec = null;
        setTimeout(function(){
          if (!srIntent) return;
          var fresh = buildAndStartSR(baseFinal);
          if (fresh) speechRec = fresh;
        }, 500);
      };

      try { rec.start(); return rec; }
      catch(e){ console.warn('[voice-runtime] SR start', e); return null; }
    }

    // opts.append === true 면 기존 baseFinal/audioChunks/timer 누적 (이어서 말하기)
    function startRecording(opts){
      var append = !!(opts && opts.append);
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
        toast('이 브라우저는 마이크 사용을 지원하지 않아요 🙏');
        return;
      }
      navigator.mediaDevices.getUserMedia({ audio: true }).then(function(stream){
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
        lastFullFinal = ''; // 새 SR 세션 — Galaxy dedup state 초기화
        srRestarts = [];
        srIntent = true;
        speechRec = buildAndStartSR(baseFinal);

        body.classList.remove('is-reviewing');
        body.classList.add('is-recording');
        clearInterval(secTimer);
        secTimer = setInterval(function(){
          seconds++;
          if (timerText) timerText.textContent = fmtTime(seconds);
        }, 1000);
      }).catch(function(err){
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
      try { if (mediaRec && mediaRec.state !== 'inactive') mediaRec.stop(); } catch(e){}
      if (mediaRec && mediaRec.stream){
        try { mediaRec.stream.getTracks().forEach(function(t){ t.stop(); }); } catch(e){}
      }
      body.classList.remove('is-recording');
      body.classList.add('is-reviewing');
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

    // ── mic 버튼 토글: 녹음 중이면 정지(검토 진입), 아니면 새로 시작
    //    검토 상태에서 mic 다시 누르면 "이어서" 가 아니라 "새로 시작" — 사용자 의도가
    //    명확한 mic 아이콘 클릭은 fresh start 로 처리. 이어서 말하려면 continueBtn 사용.
    micBtn.addEventListener('click', function(){
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
        if (timerText) timerText.textContent = fmtTime(0);
        if (transcriptBody){
          transcriptBody.innerHTML = '<span class="ph">말씀하시면 여기에 글자로 옮겨 드립니다.</span>';
        }
        body.classList.remove('is-recording', 'is-reviewing');
      });
    }

    // ── 확인(다음) 버튼 — 업로드 트리거 (capture phase로 데모 핸들러보다 먼저)
    if (confirmBtn){
      confirmBtn.addEventListener('click', function(){
        uploadAudio().then(function(url){
          if (url) console.log('[voice-runtime] saved audio:', url);
          // 다음 질문 진행은 voice.html 데모 로직이 그대로 처리
          // 다음 질문을 위한 상태 초기화
          audioChunks = [];
          baseFinal = '';
          lastFullFinal = '';
          lastUploadedUrl = null;
          seconds = 0;
        });
      }, true);
    }

    console.log('[voice-runtime] wired — mic/STT/Supabase ready');
  };
})();
