/**
 * 영지의 개인 대시보드 - Cloudflare Workers 버전
 *
 * PHP curl_multi + 파일캐시 -> Workers Promise.allSettled + fetch(cf.cacheTtl) 로 포팅.
 * - 모든 외부 요청은 Promise.allSettled로 완전 병렬 실행 (한 사이트 지연이 전체를 막지 않음)
 * - 각 요청 8초 타임아웃 (AbortSignal.timeout)
 * - cf: { cacheTtl: 300, cacheEverything: true } 로 Cloudflare 엣지에 5분 캐시
 *   -> 캐시 히트 시 서버(오리진) 왕복 없이 엣지에서 즉시 응답, PHP 파일캐시보다 빠름
 * - investing.com 마크업(2026-07 리뉴얼 반영): data-test="instrument-price-last" /
 *   data-test="instrument-price-change-percent"
 * - knoc.co.kr 개편: <div class="price"><strong>가격</strong></div>
 * - goldgold.co.kr 폐쇄 -> investing.com 국제 금 시세로 대체
 * - [2026-07] 우측 상단 코스피~미세먼지 박스가 화면을 가린다는 피드백 반영:
 *   시계는 항상 보이고, 그 아래는 항목을 한 줄씩 3초 간격으로 순환 표시.
 *   그 영역을 클릭하면 전체 목록이 펼쳐지고, 펼쳐진 상태에서 개별 항목을
 *   클릭하면 원래 링크(investing.com 등)로 이동. 이 상세 로직은 아래
 *   getFinanceData() / buildDashboard()의 플로팅 박스 스크립트를 참고.
 */

const TIMEOUT_MS = 20000; // Cron 백그라운드 실행이라 사용자 체감 속도엔 영향 없음. 넉넉하게.
const CACHE_TTL = 300; // 5분

async function fetchText(url, encoding = 'utf-8') {
  try {
    const origin = new URL(url).origin;
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
        Referer: origin + '/',
      },
      cf: { cacheTtl: CACHE_TTL, cacheEverything: true },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const httpCode = res.status;
    // PHP의 mb_convert_encoding 대응: euc-kr 등 non-utf8 응답은 바이트로 받아 TextDecoder로 디코딩
    const buf = await res.arrayBuffer();
    const text = new TextDecoder(encoding).decode(buf);
    return { text, httpCode, error: null };
  } catch (e) {
    return { text: '', httpCode: 0, error: e.message || String(e) };
  }
}

// 여러 URL을 완전 병렬로 요청. 실패해도 다른 요청을 막지 않음.
// encodingMap: { key: 'euc-kr' } 형태로 특정 사이트만 다른 인코딩 지정 가능 (기본 utf-8)
async function fetchAllParallel(urlMap, encodingMap = {}) {
  const keys = Object.keys(urlMap);
  const settled = await Promise.allSettled(
    keys.map((k) => fetchText(urlMap[k], encodingMap[k] || 'utf-8'))
  );
  const results = {};
  const debug = {};
  keys.forEach((k, i) => {
    const r = settled[i].status === 'fulfilled' ? settled[i].value : { text: '', httpCode: 0, error: settled[i].reason };
    results[k] = r.text;
    debug[k] = { url: urlMap[k], httpCode: r.httpCode, error: r.error, bytes: r.text.length };
  });
  return { results, debug };
}

function m(match, idx = 1) {
  return match && match[idx] != null ? match[idx] : '';
}

function parseInvestingQuote(html) {
  const price = html.match(/data-test="instrument-price-last"[^>]*>([\s\S]*?)<\/div>/);
  const chg = html.match(/data-test="instrument-price-change-percent"[^>]*>([\s\S]*?)<\/span>/);
  return [m(price), m(chg)];
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---- 게시판 파서들 ----

function parseSlrclub(html) {
  const rows = [...html.matchAll(/<td class="sbj">([\s\S]*?)<\/tr>/g)];
  const dates = [...html.matchAll(/<td class="list_date no_att">([\s\S]*?)<\/td>/g)];
  const out = [];
  for (let x = 1; x <= 27 && x < rows.length; x++) {
    let block = rows[x][0]
      .replace(/vx2\.php/g, 'http://m.slrclub.com/bbs/vx2.php')
      .replace('<td class="sbj">', '<td height=40px>')
      .replace(/a href="\/bbs\//g, "a style=color:red target='_blank' href=\"");
    const link = block.match(/<a style=color:red target[\s\S]*?<\/a>/);
    const linkHtml = link ? link[0].replace(' style=color:red', ' style=color:#1a1a1a') : '';
    const date = dates[x] ? dates[x][1] : '';
    out.push(
      `<tr><td height=35><div style=width:0px;overflow:hidden>${date}</div></td><td width=100% style='background:#e49ca1'>sl. ${linkHtml}</td></tr>\n`
    );
  }
  return out;
}

function parsePpomppu(html) {
  const out = [];
  const re = /<a href="([^"]*)"><font class="list_title">[^>]*>([^<]*)</g;
  let mm;
  while ((mm = re.exec(html)) !== null) {
    const href = mm[1];
    const title = (mm[2] || '').trim();
    if (title) {
      out.push(
        `<tr><td height=35><div style=width:0px;overflow:hidden></div></td><td width=100% style="background:#D3C4E3">pm.<a href='https://www.ppomppu.co.kr${href}' target=_blank>${title}</a></td></tr>\n`
      );
    }
  }
  return out;
}

// 2026-07 확인: mlbpark 셀 안 앵커 순서는 [카테고리, 제목, 댓글수([n])].
// 댓글수가 없는 글도 있어 순서가 흔들릴 수 있으므로, "[숫자]" 형태(댓글수)만
// 걸러내고 남은 마지막 앵커를 제목으로 사용.
function parseMlbpark(html) {
  const out = [];
  const reTd = /<td class='t_left[^']*' id='list_\d+'>([\s\S]*?)<\/td>/g;
  let td;
  let count = 0;
  while ((td = reTd.exec(html)) !== null && count < 30) {
    const anchors = [...td[1].matchAll(/<a[^>]*href='([^']+)'[^>]*>([\s\S]*?)<\/a>/g)]
      .map((a) => ({ href: a[1], text: a[2].replace(/<[^>]+>/g, '').trim() }))
      .filter((a) => a.text && !/^\[\d+\]$/.test(a.text));
    if (!anchors.length) continue;
    const { href, text: title } = anchors[anchors.length - 1];
    out.push(
      `<tr><td height=35><div style=width:0px;overflow:hidden></div></td><td style='background:#AFB5FA'>bl. <a style=color:#1a1a1a target=_blank href="${href}">${title}</a></td></tr>\n`
    );
    count++;
  }
  return out;
}

function parseBobaedream(html) {
  const links = [...html.matchAll(/<a class="bsubject" ([\s\S]*?)<\/a>/g)];
  const dates = [...html.matchAll(/<td class="date">([\s\S]*?)<\/td>/g)];
  const out = [];
  for (let x = 8; x <= 34 && x < links.length; x++) {
    const block = links[x][0];
    const hrefMatch = block.match(/href="([^"]+)"/);
    const href = hrefMatch
      ? hrefMatch[1].replace('/view?code', 'https://bobaedream.co.kr/view?code')
      : '#';
    // 원본 사이트의 인라인 스타일(폰트 크기 등)이 다른 게시판과 다르게 섞여
    // 들어오는 걸 막기 위해, 내부 태그를 전부 걷어내고 순수 텍스트만 취해
    // 깨끗한 <a> 태그로 새로 만듦 (다른 게시판 파서들과 동일한 방식)
    const title = block.replace(/<[^>]+>/g, '').trim();
    const rawDate = dates[x] ? dates[x][1] : '';
    const ppdate1 = rawDate.substr(11, 9);
    out.push(
      `<tr><td height=35><div style=width:0px;overflow:hidden>${ppdate1}</div></td><td style='background:#B0B0B0;'>bb. <a target=_blank href="${href}">${title}</a></td></tr>\n`
    );
  }
  return out;
}

function parseTheqoo(html) {
  const blocks = [...html.matchAll(/<td class="title">([\s\S]*?)<\/tr>/g)];
  const out = [];
  for (let x = 7; x <= 24 && x < blocks.length; x++) {
    let pl = blocks[x][1]
      .replace('<a href="/', '<a target=_blank href="https://theqoo.net/')
      .replace('<span style="">', '')
      .replace(/<\/span>/g, '');
    const link = pl.match(/<a .*?>([\s\S]*?)<\/a>/);
    const linkHtml = link ? link[0] : '';
    if (linkHtml && !linkHtml.includes('reply')) {
      out.push(
        `<tr><td height=35><div style=width:0px;overflow:hidden></div></td><td style='background:#EFB3aa;'>tq. ${linkHtml}</td></tr>\n`
      );
    }
  }
  return out;
}

function parseCoinpan(html) {
  const items = [...html.matchAll(/<a href="\/free\/([\s\S]*?)<\/a>/g)];
  const out = [];
  for (let x = 5; x <= 31 && x < items.length; x++) {
    let it = items[x][0].replace(/ {2}/g, '').replace('<a href="/', '<a target=_blank href="https://coinpan.com/');
    if (!it.includes('#comment')) {
      out.push(
        `<tr><td height=35><div style=width:0px;overflow:hidden></div></td><td style='background:#F9D43C;'>cp. ${it}</a></td></tr>\n`
      );
    }
  }
  return out;
}

// 클리앙 새로운소식 (IT/과학 뉴스 전용 게시판)
// 주의: 클리앙 실제 HTML 마크업을 직접 확인하지 못한 상태로 일반적인 패턴
// (class="list_subject" 제목링크, class="list_time" 작성시각) 기준 작성함.
// 배포 후 DASH_DEBUG에서 bytes>0인데 항목이 안 뜨면 실제 마크업이 달라진 것이므로
// 클리앙 서버 응답을 직접 확인해 정규식을 맞춰야 함.
// 클리앙 새로운소식 (IT/과학 뉴스 전용 게시판)
// 2026-07 확인: 실제 응답에서 list_subject 클래스는 더 이상 없고,
// href="/service/board/news/19197895?od=T31&po=0&category=0&groupCd=" 형태만 확인됨.
// 댓글수 링크는 같은 href 뒤에 #comment-point 가 붙으므로 [^"#]* 로 제외.
function parseClienBoard(html, boardPath, prefix, bg) {
  const out = [];
  const re = new RegExp(`<a[^>]*href="(/service/board/${boardPath}/\\d+\\?[^"#]*)"[^>]*>([\\s\\S]*?)</a>`, 'g');
  let mm;
  let count = 0;
  const seen = new Set();
  while ((mm = re.exec(html)) !== null && count < 30) {
    const href = mm[1];
    const title = mm[2].replace(/<[^>]+>/g, '').trim();
    if (title && !seen.has(href)) {
      seen.add(href);
      out.push(
        `<tr><td height=35><div style=width:0px;overflow:hidden></div></td><td width=100% style="background:${bg}">${prefix}. <a target=_blank href="https://www.clien.net${href}">${title}</a></td></tr>\n`
      );
      count++;
    }
  }
  return out;
}
function parseClien(html) {
  return parseClienBoard(html, 'news', 'cl', '#C4E3D3');
}
// 클리앙 소모임 "주식한당" (주식/재테크)
function parseClienStock(html) {
  return parseClienBoard(html, 'cm_stock', 'jj', '#FFD8A8');
}

// 팍스넷 시황분석 게시판 (paxnet.co.kr) - 국내 최대 주식 커뮤니티 중 하나
// 각 글은 제목링크+요약링크가 같은 href를 공유해서 2번 나오므로 href로 중복 제거.
// 따옴표 스타일이 사이트마다 달라 "나 ' 둘 다 허용.
function parsePaxnet(html) {
  const out = [];
  const re = /href=["']([^"']*\/tbbs\/view\?id=[^"'&]+&seq=\d+[^"']*)["'][^>]*>([\s\S]*?)<\/a>/g;
  let mm;
  let count = 0;
  const seen = new Set();
  while ((mm = re.exec(html)) !== null && count < 30) {
    let href = mm[1];
    if (href.startsWith('/')) href = `https://www.paxnet.co.kr${href}`;
    if (seen.has(href)) continue;
    const title = mm[2].replace(/<[^>]+>/g, '').trim();
    if (!title) continue;
    seen.add(href);
    out.push(
      `<tr><td height=35><div style=width:0px;overflow:hidden></div></td><td width=100% style='background:#FFB4A2;color:#1a1a1a'>px. <a style=color:#1a1a1a target=_blank href="${href}">${title}</a></td></tr>\n`
    );
    count++;
  }
  return out;
}

// 디시인사이드 주식 갤러리 (neostock) - 미러/마이너 아닌 정식 메이저 갤러리.
// 메이저 갤러리는 URL에 /mgallery/ 접두사가 없는 경우가 많아 optional 처리.
function parseDcNeostock(html) {
  const out = [];
  const re = /<a[^>]*href="((?:\/mgallery)?\/board\/view\/\?id=neostock&no=\d+[^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  let mm;
  let count = 0;
  const seen = new Set();
  while ((mm = re.exec(html)) !== null && count < 30) {
    const path = mm[1];
    if (seen.has(path)) continue;
    const title = mm[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!title || /^\d+$/.test(title)) continue;
    seen.add(path);
    out.push(
      `<tr><td height=35><div style=width:0px;overflow:hidden></div></td><td width=100% style='background:#C9E4DE;color:#1a1a1a'>ns. <a style=color:#1a1a1a target=_blank href="https://gall.dcinside.com${path}">${title}</a></td></tr>\n`
    );
    count++;
  }
  return out;
}

// 디자인정글 정글톡톡 (jungle.co.kr/community/talktalk) - 디자이너 커뮤니티
// 서버렌더링 확인됨. 글 링크는 /community/숫자 형태.
function parseJungleTalk(html) {
  const out = [];
  const re = /href=["'](?:https?:\/\/www\.jungle\.co\.kr)?(\/community\/\d+)["'][^>]*>([\s\S]*?)<\/a>/g;
  let mm;
  let count2 = 0;
  const seen2 = new Set();
  while ((mm = re.exec(html)) !== null && count2 < 30) {
    const path = mm[1];
    if (seen2.has(path)) continue;
    const title = mm[2].replace(/<[^>]+>/g, '').trim();
    if (!title) continue;
    seen2.add(path);
    out.push(
      `<tr><td height=35><div style=width:0px;overflow:hidden></div></td><td width=100% style='background:#FDE8B0;color:#1a1a1a'>jg. <a style=color:#1a1a1a target=_blank href="https://www.jungle.co.kr${path}">${title}</a></td></tr>\n`
    );
    count2++;
  }
  return out;
}

// 디시인사이드 디자인,일러스트 갤러리 (id=design) - 메이저 갤러리
function parseDcDesign(html) {
  const out = [];
  const re = /<a[^>]*href="((?:\/mgallery)?\/board\/view\/\?id=design&no=\d+[^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  let mm;
  let count3 = 0;
  const seen3 = new Set();
  while ((mm = re.exec(html)) !== null && count3 < 30) {
    const path = mm[1];
    if (seen3.has(path)) continue;
    const title = mm[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!title || /^\d+$/.test(title)) continue;
    seen3.add(path);
    out.push(
      `<tr><td height=35><div style=width:0px;overflow:hidden></div></td><td width=100% style='background:#E8C4E8;color:#1a1a1a'>dg. <a style=color:#1a1a1a target=_blank href="https://gall.dcinside.com${path}">${title}</a></td></tr>\n`
    );
    count3++;
  }
  return out;
}

// 디시인사이드 프로그래밍 갤러리 (id=programming) - 메이저 갤러리
function parseDcProgramming(html) {
  const out = [];
  const re = /<a[^>]*href="((?:\/mgallery)?\/board\/view\/\?id=programming&no=\d+[^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  let mm;
  let count4 = 0;
  const seen4 = new Set();
  while ((mm = re.exec(html)) !== null && count4 < 30) {
    const path = mm[1];
    if (seen4.has(path)) continue;
    const title = mm[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!title || /^\d+$/.test(title)) continue;
    seen4.add(path);
    out.push(
      `<tr><td height=35><div style=width:0px;overflow:hidden></div></td><td width=100% style='background:#D6E5FA;color:#1a1a1a'>pg. <a style=color:#1a1a1a target=_blank href="https://gall.dcinside.com${path}">${title}</a></td></tr>\n`
    );
    count4++;
  }
  return out;
}
// /mgallery/board/view/?id=krstock&no=숫자 형태.
function parseKrStock(html) {
  const out = [];
  const re = /<a[^>]*href="(\/mgallery\/board\/view\/\?id=krstock&no=\d+[^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  let mm;
  let count = 0;
  const seen = new Set();
  while ((mm = re.exec(html)) !== null && count < 30) {
    const path = mm[1];
    if (seen.has(path)) continue;
    const title = mm[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!title || /^\d+$/.test(title)) continue;
    seen.add(path);
    out.push(
      `<tr><td height=35><div style=width:0px;overflow:hidden></div></td><td width=100% style='background:#B5EAD7;color:#1a1a1a'>ks. <a style=color:#1a1a1a target=_blank href="https://gall.dcinside.com${path}">${title}</a></td></tr>\n`
    );
    count++;
  }
  return out;
}

// OKKY 커뮤니티 (okky.kr/community) - 국내 최대 개발자 커뮤니티
// 서버렌더링 확인됨. 글 링크는 /articles/숫자?topic=community 또는
// /spaces/스페이스명/숫자?topic=community 형태.
function parseOkky(html) {
  const out = [];
  const re = /href=["'](?:https?:\/\/okky\.kr)?(\/(?:articles|spaces\/[^\/"']+)\/\d+\?topic=community)["'][^>]*>([\s\S]*?)<\/a>/g;
  let mm;
  let count = 0;
  const seen = new Set();
  while ((mm = re.exec(html)) !== null && count < 30) {
    const path = mm[1];
    if (seen.has(path)) continue;
    const title = mm[2].replace(/<[^>]+>/g, '').trim();
    if (!title) continue;
    seen.add(path);
    out.push(
      `<tr><td height=35><div style=width:0px;overflow:hidden></div></td><td width=100% style='background:#BFD7EA;color:#1a1a1a'>ok. <a style=color:#1a1a1a target=_blank href="https://okky.kr${path}">${title}</a></td></tr>\n`
    );
    count++;
  }
  return out;
}

// 2026-07 확인: 속성이 작은따옴표('). 제목은
// <a href='...'><h2 class='topic-title-heading'>제목</h2></a> 형태.
function parseGeekNews(html) {
  const out = [];
  const re = /<a href='([^']+)'[^>]*><h2 class='topic-title-heading'>([\s\S]*?)<\/h2>/g;
  let mm;
  let count = 0;
  while ((mm = re.exec(html)) !== null && count < 30) {
    let href = mm[1];
    if (!href.startsWith('http')) href = `https://news.hada.io/${href}`;
    const title = mm[2].replace(/<[^>]+>/g, '').trim();
    if (title) {
      out.push(
        `<tr><td height=35><div style=width:0px;overflow:hidden></div></td><td width=100% style='background:#A8D8FF;color:#1a1a1a'>gn. <a style=color:#1a1a1a target=_blank href="${href}">${title}</a></td></tr>\n`
      );
      count++;
    }
  }
  return out;
}

// 우측 상단 박스(코스피~미세먼지, investing.com + 휘발유 + 미세먼지)는 전부 묶어서
// 하루 8번 정도(=3시간에 한 번)만 새로 받아오도록 캐시. 게시판만 지금처럼
// Cron 주기(10분)마다 그대로 갱신.
const FINANCE_TTL_MS = 3 * 60 * 60 * 1000; // 3시간 = 하루 8회
// v2: 캐시에 저장하는 형태를 문자열(html) -> 개별 항목 배열(items)로 변경
// (플로팅 박스에서 항목별로 순환/펼치기를 하려면 항목 단위 데이터가 필요해서)
const FINANCE_KV_KEY = 'finance_cache_v2';

// investing.com 등에서 우측 상단 박스에 들어갈 항목들을 "개별 항목 배열"로 반환.
// (예전엔 하나의 긴 html 문자열이었지만, 이제 프론트에서 한 줄씩 순환 표시해야
// 하므로 항목 단위로 쪼개서 돌려줌. 각 항목은 그 자체로 완결된 <a>...</a> 조각)
async function getFinanceData(env, forceFresh) {
  const financeUrls = {
    kospi: 'https://kr.investing.com/indices/kospi',
    kosdaq: 'https://kr.investing.com/indices/kosdaq',
    nasdaq: 'https://kr.investing.com/indices/nasdaq-composite',
    dow: 'https://kr.investing.com/indices/us-30',
    sp500: 'https://kr.investing.com/indices/us-spx-500',
    btc: 'https://kr.investing.com/crypto/bitcoin/btc-usd',
    usdkrw: 'https://kr.investing.com/currencies/usd-krw',
    eurkrw: 'https://kr.investing.com/currencies/eur-krw',
    cnykrw: 'https://kr.investing.com/currencies/cny-krw',
    jpykrw: 'https://kr.investing.com/currencies/jpy-krw',
    gold: 'https://kr.investing.com/commodities/gold',
    oil: 'http://www.knoc.co.kr/',
    dust: 'http://www.kweather.co.kr/air/air_forecast.html',
  };

  if (!forceFresh && env.DASH_KV) {
    const cachedRaw = await env.DASH_KV.get(FINANCE_KV_KEY);
    if (cachedRaw) {
      try {
        const cached = JSON.parse(cachedRaw);
        if (cached.items && Date.now() - cached.generatedAt < FINANCE_TTL_MS) {
          return { items: cached.items, debug: cached.debug };
        }
      } catch (e) {
        // 파싱 실패하면 그냥 새로 받아옴
      }
    }
  }

  const { results: fin, debug: finDebug } = await fetchAllParallel(financeUrls);
  const items = [];
  const addQuote = (key, label, link) => {
    const [price, chg] = parseInvestingQuote(fin[key]);
    items.push(
      `<a target=_blank href=${link || financeUrls[key]}>${label} <font style=color:red;font-weight:bold>${price}</font> ${chg}</a>`
    );
  };
  addQuote('kospi', '피');
  addQuote('kosdaq', '닥');
  addQuote('nasdaq', '나');
  addQuote('dow', '뉴');
  addQuote('sp500', 'sp');
  addQuote('btc', '비', 'https://upbit.com/exchange?code=CRIX.UPBIT.KRW-BTC');
  {
    const [price, chg] = parseInvestingQuote(fin.usdkrw);
    items.push(`<a href=${financeUrls.usdkrw} target=_blank>1달 <font style=color:red;font-weight:bold>${price}</font> ${chg}</a>`);
  }
  {
    const [price, chg] = parseInvestingQuote(fin.eurkrw);
    items.push(`<a href=${financeUrls.eurkrw} target=_blank>1유 <font style=color:red;font-weight:bold>${price}</font> ${chg}</a>`);
  }
  {
    const [price, chg] = parseInvestingQuote(fin.cnykrw);
    items.push(
      `<a href=https://kr.investing.com/currencies/cny-krw-converter target=_blank>1위 <font style=color:red;font-weight:bold>${price}</font> ${chg}</a>`
    );
  }
  {
    const [price, chg] = parseInvestingQuote(fin.jpykrw);
    items.push(
      `<a href=https://kr.investing.com/currencies/jpy-krw-converter target=_blank>1엔 <font style=color:red;font-weight:bold>${price}</font> ${chg}</a>`
    );
  }
  {
    const oil = fin.oil.match(/<div class="price">\s*<strong>([\s\S]*?)<\/strong>/);
    // 참고: 예전 코드는 이 항목의 </a> 닫는 태그가 누락돼 있었음(휘발유 다음
    // 항목들이 전부 이 링크 안에 딸려 들어가는 버그). 항목을 분리하면서 같이 고침.
    items.push(
      `<a href=http://www.opinet.co.kr/user/main/mainView.do target=_blank>휘발 <font style=color:red;font-weight:bold>${m(oil)}</font>원</a>`
    );
  }
  {
    const [price, chg] = parseInvestingQuote(fin.gold);
    items.push(`<a href=${financeUrls.gold} target=_blank>금(국제) <font style=color:red;font-weight:bold>${price}</font> ${chg}</a>`);
  }
  {
    const pm = [...fin.dust.matchAll(/<td id="pm25_[^"]*"><img src="([\s\S]*?)" /g)].map((mm) =>
      mm[1].replace('../', 'http://www.kweather.co.kr/')
    );
    let dustHtml = '';
    for (let x = 0; x <= 5 && x < pm.length; x++) {
      dustHtml += `<img src="${pm[x]}" height=20px>`;
    }
    if (dustHtml) {
      items.push(`<a href="http://www.kweather.co.kr/air/air_forecast_3hr.html" target=_blank>${dustHtml}</a>`);
    }
  }

  if (env.DASH_KV) {
    await env.DASH_KV.put(FINANCE_KV_KEY, JSON.stringify({ items, debug: finDebug, generatedAt: Date.now() }));
  }
  return { items, debug: finDebug };
}

// ===================== 핫이슈 누적 + AI 요약 =====================
// 동작: 30분마다 그 시점 제목 목록을 KV에 스냅샷 저장 → 6시간치가 쌓이면
// 2시간에 한 번 AI가 "지금 여러 게시판에 걸쳐 반복 등장하는 진짜 핫이슈"를
// 뽑아서 요약(+ 관련 종목 추정)해 KV에 저장. 화면 상단엔 그 결과만 표시.
// (완전 속보/단발성 글은 어차피 아래 실시간 리스트에서 보이므로 여기선 안 다룸)
const HOT_SNAP_PREFIX = 'hotsnap:';
const HOT_SNAP_RETAIN_MS = 6 * 60 * 60 * 1000; // 스냅샷 보관 6시간
const HOT_SNAP_INTERVAL_MS = 30 * 60 * 1000; // 30분마다 스냅샷
const HOT_SUMMARY_KEY = 'hot_topics_v1';
const HOT_SUMMARY_META_KEY = 'hot_topics_last_run';
const HOT_SUMMARY_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2시간마다 AI 요약

function extractTitlesFromList(allList) {
  const joined = allList.join('');
  const matches = [...joined.matchAll(/<a[^>]*target=_blank[^>]*href="[^"]*"[^>]*>([\s\S]*?)<\/a>/g)];
  const seen = new Set();
  const out = [];
  for (const m of matches) {
    const t = m[1].replace(/<[^>]+>/g, '').trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

// 30분 단위 정각에만 실제로 저장 (Cron이 그보다 자주 돌아도 과도하게 안 쌓임)
async function maybeSaveHotSnapshot(env, allList) {
  if (!env.DASH_KV) return;
  const now = Date.now();
  const bucket = Math.floor(now / HOT_SNAP_INTERVAL_MS);
  const lastBucketRaw = await env.DASH_KV.get('hotsnap_last_bucket');
  if (lastBucketRaw && Number(lastBucketRaw) === bucket) return;

  const titles = extractTitlesFromList(allList);
  if (!titles.length) return;

  await env.DASH_KV.put(`${HOT_SNAP_PREFIX}${now}`, JSON.stringify(titles), {
    expirationTtl: Math.ceil(HOT_SNAP_RETAIN_MS / 1000) + 600,
  });
  await env.DASH_KV.put('hotsnap_last_bucket', String(bucket));

  // 6시간 지난 스냅샷 정리 (KV 무료 티어 quota 보호 - 예전에 겪은 문제 재발 방지)
  const list = await env.DASH_KV.list({ prefix: HOT_SNAP_PREFIX });
  const cutoff = now - HOT_SNAP_RETAIN_MS;
  for (const key of list.keys) {
    const ts = Number(key.name.slice(HOT_SNAP_PREFIX.length));
    if (ts && ts < cutoff) {
      await env.DASH_KV.delete(key.name);
    }
  }
}

// 2시간에 한 번, 누적된 스냅샷 전체를 묶어 AI에게 "핫이슈 Top5 + 관련종목" 요청.
// env.AI (Workers AI) 바인딩이 없으면 조용히 스킵.
async function maybeSummarizeHotTopics(env) {
  if (!env.DASH_KV) return;
  if (!env.AI) {
    await env.DASH_KV.put('hot_topics_debug', 'AI 바인딩 없음 (env.AI undefined) - 대시보드에서 Workers AI 바인딩을 변수명 AI로 추가해야 함');
    return;
  }
  const now = Date.now();
  const lastRunRaw = await env.DASH_KV.get(HOT_SUMMARY_META_KEY);
  if (lastRunRaw && now - Number(lastRunRaw) < HOT_SUMMARY_INTERVAL_MS) return;

  const list = await env.DASH_KV.list({ prefix: HOT_SNAP_PREFIX });
  if (!list.keys.length) {
    await env.DASH_KV.put('hot_topics_debug', `스냅샷 0개 (아직 30분 주기가 안 돌았거나 저장이 안 되는 중) at ${new Date(now).toISOString()}`);
    return;
  }

  const allTitles = [];
  for (const key of list.keys) {
    const raw = await env.DASH_KV.get(key.name);
    if (!raw) continue;
    try {
      allTitles.push(...JSON.parse(raw));
    } catch (e) {
      /* 손상된 스냅샷은 무시 */
    }
  }
  if (allTitles.length < 20) {
    await env.DASH_KV.put('hot_topics_debug', `스냅샷 ${list.keys.length}개, 제목 ${allTitles.length}개 - 20개 미만이라 대기 중 at ${new Date(now).toISOString()}`);
    return;
  }

  const prompt = `다음은 최근 몇 시간 동안 한국 여러 커뮤니티/주식 게시판에 올라온 글 제목 목록이다.
같은 이슈를 다루는 제목들을 하나로 묶어서, 지금 가장 화제가 되는 주제 상위 5개를 뽑아라.

각 주제마다:
- topic: 주제를 한 줄로 (10~20자)
- reason: 왜 화제인지 한 줄 요약
- stocks: 이 주제와 직접 관련된 국내/미국 상장 종목명이 있으면 배열로 (억지로 끼워맞추지 말고, 없으면 빈 배열)

아래 JSON 배열 형식으로만 답하라. 다른 설명은 절대 넣지 마라.
[{"topic":"...","reason":"...","stocks":["...","..."]}]

제목 목록:
${allTitles.slice(0, 400).join('\n')}`;

  try {
    const res = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 900,
    });
    const raw = (res.response || '').trim();
    const jsonStr = raw.replace(/^```json\s*|```\s*$/g, '').trim();
    const parsed = JSON.parse(jsonStr);
    if (Array.isArray(parsed) && parsed.length) {
      await env.DASH_KV.put(HOT_SUMMARY_KEY, JSON.stringify({ items: parsed, generatedAt: now }));
      await env.DASH_KV.put('hot_topics_debug', `성공: ${parsed.length}개 주제 저장 at ${new Date(now).toISOString()}`);
    } else {
      await env.DASH_KV.put('hot_topics_debug', `AI 응답은 받았는데 배열이 비어있거나 형식이 다름. raw: ${raw.slice(0, 500)}`);
    }
  } catch (e) {
    await env.DASH_KV.put('hot_topics_debug', `에러: ${e.message || String(e)} at ${new Date(now).toISOString()}`);
  } finally {
    // 실패하더라도 다음 사이클까지 텀은 유지 (같은 실패를 매분 반복 호출하지 않도록)
    await env.DASH_KV.put(HOT_SUMMARY_META_KEY, String(now));
  }
}

// 화면 최상단에 보여줄 핫이슈 박스 HTML
async function renderHotTopicsBox(env) {
  if (!env.DASH_KV) return '';
  const raw = await env.DASH_KV.get(HOT_SUMMARY_KEY);
  if (!raw) {
    // TEMP: 아직 요약 결과가 없을 때 원인 진단용 표시. 정상화되면 지울 것.
    const dbg = await env.DASH_KV.get('hot_topics_debug');
    const aiBound = env.AI ? 'AI바인딩:있음' : 'AI바인딩:없음';
    return `<div style="margin:8px;padding:8px 12px;background:#333;color:#0f0;font-size:12px;font-family:monospace;border-radius:8px;">
      🔥핫이슈 dbg — ${aiBound} / ${dbg ? dbg.replace(/</g, '&lt;') : '아직 기록 없음(첫 크론 실행 전)'}
    </div>`;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return '';
  }
  if (!data || !Array.isArray(data.items) || !data.items.length) return '';

  const ago = Math.max(0, Math.round((Date.now() - data.generatedAt) / 60000));
  const rows = data.items
    .map((it, i) => {
      const stocksHtml =
        it.stocks && it.stocks.length
          ? `<div style="margin-top:4px;font-size:13px;color:#0a7a3d;">📈 관련종목: ${it.stocks.join(', ')}</div>`
          : '';
      return `<div style="padding:10px 14px;border-bottom:1px solid rgba(0,0,0,0.08);">
        <div style="font-weight:bold;font-size:16px;color:#111;">${i + 1}. ${it.topic}</div>
        <div style="font-size:13px;color:#555;margin-top:2px;">${it.reason}</div>
        ${stocksHtml}
      </div>`;
    })
    .join('');

  return `<div style="margin:8px;border-radius:12px;overflow:hidden;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,0.15);">
    <div style="background:#222;color:#fff;padding:8px 14px;font-weight:bold;font-size:14px;">🔥 지금 가장 뜨거운 주제 (${ago}분 전 기준)</div>
    ${rows}
  </div>`;
}

// 같은 제목이 2일 넘게 계속 리스트에 나오면 고정글/광고글로 보고 제외.
// (게시판 원문엔 날짜가 없어서 "처음 본 시각" 기준으로 판단하는 방식)
const SEEN_TITLES_KEY = 'seen_titles_v1';
const STALE_THRESHOLD_MS = 2 * 24 * 60 * 60 * 1000; // 2일
const SEEN_PRUNE_MS = 4 * 24 * 60 * 60 * 1000; // 4일 이상 안 보이면 기록에서 정리

async function filterStaleRows(env, rows) {
  if (!env.DASH_KV) return rows;
  const now = Date.now();
  let seen = {};
  try {
    const raw = await env.DASH_KV.get(SEEN_TITLES_KEY);
    if (raw) seen = JSON.parse(raw);
  } catch (e) {
    seen = {};
  }

  const currentTitles = new Set();
  const filtered = [];
  for (const rowHtml of rows) {
    const m = rowHtml.match(/<a[^>]*target=_blank[^>]*>([\s\S]*?)<\/a>/);
    const title = m ? m[1].replace(/<[^>]+>/g, '').trim() : null;
    if (!title) {
      filtered.push(rowHtml);
      continue;
    }
    currentTitles.add(title);
    if (!seen[title]) seen[title] = now;
    if (now - seen[title] < STALE_THRESHOLD_MS) {
      filtered.push(rowHtml);
    }
    // else: 2일 넘게 계속 나오는 제목 - 고정글/광고로 판단하고 목록에서 제외
  }

  // 오래 안 보인 기록은 정리 (KV quota 보호)
  for (const t of Object.keys(seen)) {
    if (!currentTitles.has(t) && now - seen[t] > SEEN_PRUNE_MS) delete seen[t];
  }
  await env.DASH_KV.put(SEEN_TITLES_KEY, JSON.stringify(seen));

  return filtered;
}

async function buildDashboard(env, forceFreshFinance = false) {
    const boardUrls = {
      slrclub: 'http://www.slrclub.com/bbs/zboard.php?id=free',
      ppomppu: 'https://www.ppomppu.co.kr/all_bbs.php',
      mlbpark: 'http://mlbpark.donga.com/mp/b.php?b=bullpen',
      bobaedream: 'https://bobaedream.co.kr/list?code=freeb',
      theqoo: 'https://theqoo.net/total',
      clien: 'https://www.clien.net/service/board/news',
      clienstock: 'https://www.clien.net/service/board/cm_stock',
      geeknews: 'https://news.hada.io/',
      okky: 'https://okky.kr/community',
      krstock: 'https://m.dcinside.com/board/krstock',
      paxnet: 'http://www.paxnet.co.kr/tbbs/list?tbbsType=L&id=N00801',
      neostock: 'https://m.dcinside.com/board/neostock',
      jungletalk: 'https://www.jungle.co.kr/community/talktalk',
      dcdesign: 'https://m.dcinside.com/board/design',
      dcprogramming: 'https://m.dcinside.com/board/programming',
    };

    // 게시판은 지금처럼 매 Cron마다 새로 받음.
    // 우측 상단 박스 전체(investing.com+휘발유+미세먼지)는 별도 함수에서
    // 3시간 캐시 여부를 알아서 판단.
    const { results: boards, debug: boardDebug } = await fetchAllParallel(boardUrls, { ppomppu: 'euc-kr' });
    const { items: financeItems, debug: financeDebug } = await getFinanceData(env, forceFreshFinance);

    // 게시판 통합
    let allList = [];
    const parsedCounts = {};
    const addBoard = (key, arr) => {
      parsedCounts[key] = arr.length;
      allList = allList.concat(arr);
    };
    addBoard('slrclub', parseSlrclub(boards.slrclub));
    addBoard('ppomppu', parsePpomppu(boards.ppomppu));
    addBoard('mlbpark', parseMlbpark(boards.mlbpark));
    addBoard('bobaedream', parseBobaedream(boards.bobaedream));
    addBoard('theqoo', parseTheqoo(boards.theqoo));
    addBoard('clien', parseClien(boards.clien));
    addBoard('clienstock', parseClienStock(boards.clienstock));
    addBoard('geeknews', parseGeekNews(boards.geeknews));
    addBoard('okky', parseOkky(boards.okky));
    addBoard('krstock', parseKrStock(boards.krstock));
    addBoard('paxnet', parsePaxnet(boards.paxnet));
    addBoard('neostock', parseDcNeostock(boards.neostock));
    addBoard('jungletalk', parseJungleTalk(boards.jungletalk));
    addBoard('dcdesign', parseDcDesign(boards.dcdesign));
    addBoard('dcprogramming', parseDcProgramming(boards.dcprogramming));
    allList = await filterStaleRows(env, allList);
    shuffle(allList);
    await maybeSaveHotSnapshot(env, allList);
    const hotTopicsHtml = await renderHotTopicsBox(env);

    const debugAll = { ...financeDebug, ...boardDebug };
    const debugHtml = Object.entries(debugAll)
      .map(
        ([k, v]) =>
          `[${k}] http=${v.httpCode} error=${v.error || ''} bytes=${v.bytes} url=${v.url}`
      )
      .join('\n');

    // 플로팅 박스용 데이터
    // - financeItemsJson: 클라이언트 스크립트에 그대로 심을 JS 배열 리터럴.
    //   "</script>" 로 끊기지 않도록 '<' 를 < 로 이스케이프.
    // - financeExpandedHtml: 클릭해서 펼쳤을 때 보여줄, 항목을 한 줄씩 쌓은 버전
    const financeItemsJson = JSON.stringify(financeItems).replace(/</g, '\\u003c');
    const financeExpandedHtml = financeItems.map((it) => it + '<BR>').join('\n');

    const html = `<html>
<head>
<meta http-equiv="Content-type" content="text/html; charset=UTF-8">
<meta name="viewport" content="user-scalable=no, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, width=device-width, height=device-height">
<SCRIPT language="JavaScript">setTimeout("history.go(0);", 2400000);</SCRIPT>
<link href="https://fonts.googleapis.com/css?family=Nanum+Gothic&display=swap" rel="stylesheet">
<script type="text/javascript">
  var _paq = window._paq || [];
  _paq.push(['trackPageView']);
  _paq.push(['enableLinkTracking']);
  (function() {
    var u="//usb.kr/util/traf/";
    _paq.push(['setTrackerUrl', u+'matomo.php']);
    _paq.push(['setSiteId', '1']);
    var d=document, g=d.createElement('script'), s=d.getElementsByTagName('script')[0];
    g.type='text/javascript'; g.async=true; g.defer=true; g.src=u+'matomo.js'; s.parentNode.insertBefore(g,s);
  })();
</script>
</head>
<style type="text/css">
a { text-decoration:none; color:#000000 }
body { margin:0px; font-weight:normal; font-size:18px; }
.fixed_position { position:fixed; width:500px; right:0px; bottom: 40px; text-align:center; z-index: 999; }
</style>
<style type="text/css">
#floatdiv { position:fixed; height:30px; right:0px; display:inline-block; top:10px; background-color: transparent; margin:0; text-align:right; }
a, table {font-family: 'Nanum Gothic', sans-serif;}
#financeCollapsed { min-height:20px; }
#financeExpanded { background:transparent; padding:4px; }
#floatdiv, #floatdiv a, #floatdiv font, #floatdiv div {
  text-shadow: -1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff, 1px 1px 0 #fff, 0 0 3px #fff;
}
/* PC(가로 900px 이상)에서는 회전하며 한 줄만 보여주는 축약형 대신
   전체 시세 목록을 항상 펼쳐서 보여줌. 모바일은 기존처럼 축약/클릭펼침 유지. */
@media (min-width: 900px) {
  #financeCollapsed { display:none !important; }
  #financeExpanded { display:block !important; }
}
</style>
<div id="floatdiv">
<a id="clock" style="height:24px;font-weight:normal;color:red;font-weight:bold">00:00</a><BR>
<script>
var clockTarget = document.getElementById("clock");
function clock() {
    var date = new Date();
    var day = date.getDay();
    var week = ['일', '월', '화', '수', '목', '금', '토'];
    var hours = date.getHours();
    var minutes = date.getMinutes();
    var seconds = date.getSeconds();
    clockTarget.innerText = week[day] + '요일 ' +
    (hours < 10 ? '0'+hours : hours) + ':' + (minutes < 10 ? '0'+minutes : minutes) + ':' + (seconds < 10 ? '0'+seconds : seconds);
}
function init() { clock(); setInterval(clock, 1000); }
init();
</script>
<a id="time-result" style='height:24px;color:red'></a><BR>
<script type="text/javascript">
    var d = new Date();
    var currentDate = d.getFullYear() + "/" + ( d.getMonth() + 1 ) + "/" + ("00" + d.getDate()).slice(-2) + " ";
    var currentTime = d.getHours() + ":" +  ("00" + d.getMinutes()).slice(-2)  + ":" + ("00" + d.getSeconds()).slice(-2);
    document.getElementById("time-result").innerHTML = currentDate + "," + currentTime + "&nbsp; &nbsp; ";
</script>
<div id="financeCollapsed" onclick="fdExpand(event)" style="cursor:pointer;"></div>
<div id="financeExpanded" style="display:none;">
${financeExpandedHtml}
</div>
<script>
var financeItems = ${financeItemsJson};
var fdIndex = 0;
var fdExpanded = false;
function fdRender() {
  var el = document.getElementById('financeCollapsed');
  if (el && financeItems.length) el.innerHTML = financeItems[fdIndex];
}
function fdRotate() {
  if (fdExpanded || !financeItems.length) return;
  fdIndex = (fdIndex + 1) % financeItems.length;
  fdRender();
}
function fdExpand(e) {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  fdExpanded = true;
  document.getElementById('financeCollapsed').style.display = 'none';
  document.getElementById('financeExpanded').style.display = 'block';
}
function fdCollapse() {
  fdExpanded = false;
  document.getElementById('financeExpanded').style.display = 'none';
  document.getElementById('financeCollapsed').style.display = 'block';
}
document.addEventListener('click', function(e) {
  if (!fdExpanded) return;
  var box = document.getElementById('floatdiv');
  if (box && !box.contains(e.target)) fdCollapse();
});
fdRender();
setInterval(fdRotate, 3000);
</script>
<BR>
<a href=https://aqicn.org/map/world/kr/ target=_blank>
  <img src="http://www.kweather.co.kr/icon/air/iconFore_01.png" width="20px">
  <img src="http://www.kweather.co.kr/icon/air/iconFore_02.png" width="20px">
</a>
<a href=https://earth.nullschool.net/#current/wind/surface/level/orthographic=-236.80,36.12,1191 target=_blank>
  <img src="http://www.kweather.co.kr/icon/air/iconFore_03.png" width="20px">
  <img src="http://www.kweather.co.kr/icon/air/iconFore_04.png" width="20px">
</a>
<a href=https://www.windy.com/ko/-PM2-5-pm2p5?cams,pm2p5,33.578,132.363,5 target=_blank>
  <img src="http://www.kweather.co.kr/icon/air/iconFore_05.png" width="20px">
</a><BR>
<a href=https://analytics.google.com/analytics/web/#/report-home/a45732830w91645608p95389702 target=_blank>U</a><BR>
<a href=https://analytics.google.com/analytics/web/#/p264059873/reports/defaulthome?params=_u..nav%3Ddefault target=_blank>s</a>
</div>
<title>영지가 만들어 보는거래요..</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js"></script>
<script>
$(function() {
$('a[href*=#]:not([href=#])').click(function() {
if (location.pathname.replace(/^\\//,'') == this.pathname.replace(/^\\//,'') && location.hostname == this.hostname) {
var target = $(this.hash);
target = target.length ? target : $('[name=' + this.hash.slice(1) +']');
if (target.length) {
$('html,body').animate({ scrollTop: target.offset().top }, 700);
return false;
}
}
});
});
</script>
</head>
<body style="font-family: 'Jua', sans-serif;">
	<div class="fixed_position">
		<a href="?live=1" style='background:#e63946;color:#fff;padding:15px' target=_blank>실시간</a>
		<a href="javascript:window.location.reload(true);" style='background:blue;color:#fff;padding:15px'>리로드</a>
	</div>
${hotTopicsHtml}
<table border=0 cellpadding=0 cellspacing=0 width=100%>
${allList.join('')}
</table>
<!-- DASH_DEBUG
${debugHtml}
-->
</body>
</html>`;

  return html;
}

// --- 요청 처리: 완전 사전 생성(pre-generation) 방식 ---
//
// 이전 방식(Cache API + stale-while-revalidate)의 근본적 한계: "누가 접속해야
// 그 순간 생성이 트리거"되는 구조라서, 캐시가 비어있거나 막 만료된 순간에 걸린
// 사람은 investing.com 등 20개 사이트(특히 investing.com은 페이지당 1MB 이상,
// 8개面 다 합치면 10MB 가까이) fetch가 끝날 때까지 그대로 기다려야 했음.
//
// 바꾼 구조: Cron Trigger가 1분마다 사용자 요청과 무관하게 백그라운드에서
// buildDashboard()를 실행해 KV(DASH_KV)에 완성된 HTML을 미리 저장해 둠.
// 사용자가 접속하면 fetch 핸들러는 그 KV 값을 그대로 읽어 반환만 함 -> 응답
// 시간이 investing.com 속도와 완전히 무관해지고, KV read 한 번(수십 ms) 수준으로
// 고정됨. "느림"을 체감하는 경우는 이 워커를 처음 배포하고 첫 Cron이 아직 한 번도
// 안 돈 시점(최대 1분) 뿐이며, 그마저도 아래 폴백으로 즉시 한 번 생성해 채워 넣음.
//
// *** Cloudflare 대시보드에서 반드시 해야 하는 설정 (코드만으론 안 됨) ***
// 1) 이 Worker의 "설정 > 바인딩"에서 KV 네임스페이스 생성 후 바인딩 이름을
//    정확히 DASH_KV 로 연결 (없으면 KV 네임스페이스 새로 만들기 -> 이름 아무거나,
//    예: dashboard-cache)
// 2) 이 Worker의 "트리거" 탭에서 Cron Trigger 추가: 매 1분(* * * * *)
//    (Cron Trigger 최소 주기가 1분이라 이보다 더 자주는 불가능)
const KV_KEY = 'dashboard_html_v1';
const KV_TTL_SECONDS = 600; // KV 자체 만료(안전장치). Cron이 1분마다 갱신하므로 사실상 항상 새 값으로 덮어써짐.

async function getFromKvOrGenerate(env, ctx) {
  if (env.DASH_KV) {
    const cached = await env.DASH_KV.get(KV_KEY);
    if (cached) return cached;
  }
  // KV가 아직 비어있는 경우(최초 배포 직후, 첫 Cron 실행 전)에만 어쩔 수 없이
  // 라이브 생성. 생성 후 바로 KV에 채워 넣어 다음 사람부터는 즉시 응답되게 함.
  const html = await buildDashboard(env, false);
  if (env.DASH_KV) {
    ctx.waitUntil(env.DASH_KV.put(KV_KEY, html, { expirationTtl: KV_TTL_SECONDS }));
  }
  return html;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const isLive = url.searchParams.has('live');

    let html;
    if (isLive) {
      // 실시간 버튼: 게시판만 지금 이 순간 직접 새로 수집.
      // 우측 상단 박스 전체(코스피~미세먼지, investing.com+휘발유+미세먼지)는
      // 예외 없이 3시간(하루 8회) 캐시를 그대로 존중함 - 실시간 버튼을 눌러도
      // 이 구역의 요청 빈도는 절대 안 늘어남.
      html = await buildDashboard(env, false);
      if (env.DASH_KV) {
        ctx.waitUntil(env.DASH_KV.put(KV_KEY, html, { expirationTtl: KV_TTL_SECONDS }));
      }
    } else {
      html = await getFromKvOrGenerate(env, ctx);
    }

    return new Response(html, {
      headers: { 'content-type': 'text/html; charset=UTF-8' },
    });
  },

  // Cron Trigger가 호출. 사용자 요청과 완전히 무관하게 백그라운드에서 실행됨.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        const html = await buildDashboard(env, false);
        if (env.DASH_KV) {
          await env.DASH_KV.put(KV_KEY, html, { expirationTtl: KV_TTL_SECONDS });
        }
        // AI 요약은 사용자 요청 경로에 안 넣고 여기(크론)에서만 시도 - 지연 방지
        await maybeSummarizeHotTopics(env);
      })()
    );
  },
};
