#!/usr/bin/env python3
"""Refresh the pinned Interstellar catalog snapshot. Runtime never fetches repository data."""
from pathlib import Path
import concurrent.futures, urllib.request, urllib.error, urllib.parse, json, hashlib, re
ROOT=Path(__file__).resolve().parent.parent
SHA='1e13802605b1ff85461adcb0c438594cbe600415'
BASE=f'https://raw.githubusercontent.com/UseInterstellar/Interstellar/{SHA}'
OUT=ROOT/'web/public/catalog-art'; OUT.mkdir(parents=True,exist_ok=True)
EVIDENCE=ROOT/'evidence/panic-shortcuts'; EVIDENCE.mkdir(parents=True,exist_ok=True)
def fetch(url,limit=1000000):
 req=urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0 Atlas-Catalog-Check/1.0'})
 with urllib.request.urlopen(req,timeout=12) as r: return r.status,r.geturl(),r.read(limit+1),r.headers.get('Content-Type','')
selected_apps={'Amazon','Steam','Scratch','Chess.com','Cool Math Games','Discord','ESPN','Geforce NOW','Github','Google','HBO MAX','Messenger','MLB','NFL','NBA','Paramount Plus','Pinterest','Pixlr','Poki','Premier League','Soundcloud','Spotify','Telegram','Tiktok','Canva','Wikipedia','GOAL','Trello','Tumblr','Twitch','Twitter','VS Code','Y8 Games','YouTube','Whatsapp','Wattpad','Vercel','Amazon Luna','Google Gemini','Google Mail (Gmail)','Outlook','Snapchat','W3Schools','Newgrounds','Instagram','Proton Mail','SpaceHey','ChatGPT','DeepAI.org','Quillbot.com AI Detector'}
overrides={'Spotify':'https://open.spotify.com/','Whatsapp':'https://web.whatsapp.com/','Instagram':'https://www.instagram.com/','Snapchat':'https://web.snapchat.com/','Proton Mail':'https://mail.proton.me/','ChatGPT':'https://chatgpt.com/','HBO MAX':'https://www.hbomax.com/','Twitter':'https://x.com/'}
rows=[];seen=set(); skipped=[]
for kind,file in [('app','a'),('game','g')]:
 _,_,raw,_=fetch(f'{BASE}/static/assets/json/{file}.json')
 (EVIDENCE/f'interstellar-{file}.json').write_bytes(raw)
 for item in json.loads(raw):
  name=item['name'];url=overrides.get(name) if kind=='app' else None
  url=url or item.get('link') or (item.get('links') or [{}])[0].get('url','')
  if name.startswith('!') or (kind=='app' and name not in selected_apps) or not url.startswith('https://') or len(url)>2048:continue
  if kind=='game' and (name in ['Steam','Amazon Luna','Newgrounds','Now.GG','Android','Aptoide','Character AI'] or 'NowGG.me' in name):continue
  if name in ['2048','Hextris','Little Alchemy 2','Lichess']:continue
  u=urllib.parse.urlsplit(url)
  if u.username or u.password or not u.hostname:continue
  # Relative /e/ entries belong to another deployment, not Atlas; they are not imported.
  url=urllib.parse.urlunsplit((u.scheme,u.netloc,urllib.parse.quote(u.path,safe='/%:@'),u.query,u.fragment))
  key=(kind,url.rstrip('/'))
  if key in seen:continue
  seen.add(key)
  cats=item.get('categories',[])
  if kind=='app':
   category='Tools'
   if name in ['Spotify','Soundcloud','YouTube','Twitch','HBO MAX','Paramount Plus','ESPN']:category='Media'
   elif name in ['Discord','Telegram','Tiktok','Tumblr','Twitter','Instagram','Snapchat','SpaceHey','Messenger','Whatsapp','Pinterest']:category='Social'
   elif name in ['Google Mail (Gmail)','Outlook','Proton Mail','Trello','Canva']:category='Productivity'
   elif name in ['Google Gemini','ChatGPT','DeepAI.org','Quillbot.com AI Detector']:category='AI'
   elif name in ['Scratch','Wikipedia','W3Schools']:category='Learning'
   elif name in ['Geforce NOW','Steam','Amazon Luna','Chess.com','Cool Math Games','Poki','Y8 Games','Newgrounds']:category='Gaming'
  else:
   category='Arcade'
   if '.io' in name.lower() or '2P' in cats:category='Multiplayer'
   if any(x in name.lower() for x in ['word','quiz','brain','sudoku','connections','sugar','slice','globle']):category='Puzzle'
   if any(x in name.lower() for x in ['idle','clicker','tycoon']):category='Idle'
   if any(x in name.lower() for x in ['car','moto','racing','drive','kart']):category='Racing'
   if any(x in name.lower() for x in ['sand','fancade','minecraft']):category='Creative'
   if 'now.gg' in u.hostname or 'geforcenow' in u.hostname:category='Cloud gaming'
  ident='lib-'+hashlib.sha256((kind+':'+url).encode()).hexdigest()[:16]
  rows.append(dict(id=ident,name=name[:80],description=(f'{category} web app.' if kind=='app' else f'{category} browser game.')+(' Provider account or subscription may be required.' if category in ['Cloud gaming','Gaming'] else ''),url=url,artwork='hex',category=category,kind=kind,thumbnail='',image=item.get('image','')))
def check(row):
 result={'id':row['id'],'name':row['name'],'url':row['url']}
 try:
  code,final,_,ctype=fetch(row['url'],4096)
  result.update(status=code,final=final)
 except urllib.error.HTTPError as e: result['status']=e.code
 except Exception as e: result.update(status=0,error=type(e).__name__)
 # Exclude known missing pages and failed origins; access challenges aren't proof of breakage.
 if result['status'] in [404,410] or result['status']>=500 or result['status']==0:return None,result
 path=row.pop('image')
 if path.startswith('/assets/media/'):
  try:
   url=BASE+'/static'+path
   _,_,blob,ctype=fetch(url)
   if len(blob)<=1000000 and ('image/' in ctype or blob[:4]==b'RIFF'):
    ext=Path(path).suffix.lower()
    if ext in ['.png','.webp','.jpg','.jpeg','.gif','.ico']:
     name=row['id']+ext;(OUT/name).write_bytes(blob);row['thumbnail']='/catalog-art/'+name
     result.update(imageSource=url,imageSha256=hashlib.sha256(blob).hexdigest())
  except Exception:pass
 return row,result
with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool: results=list(pool.map(check,rows))
kept=[r for r,_ in results if r];checks=[c for _,c in results]
featured=['Cookie Clicker','Minecraft Classic','Gartic Phone','Wordle','Tetr.io','Smash Karts','Google Feud','Fancade','Slope','Run 3','ChatGPT','Google Gemini','Google','YouTube','Spotify','Discord','Canva','Wikipedia','VS Code']
kept.sort(key=lambda r:(0 if r['name'] in featured else 1,featured.index(r['name']) if r['name'] in featured else 999))
(ROOT/'server/catalog.json').write_text(json.dumps(kept,indent=2,ensure_ascii=False)+'\n')
(EVIDENCE/'catalog-checks.json').write_text(json.dumps({'repository':'UseInterstellar/Interstellar','commit':SHA,'checks':checks},indent=2)+'\n')
print(f"IMPORTED_GAMES={sum(r['kind']=='game' for r in kept)}; IMPORTED_APPS={sum(r['kind']=='app' for r in kept)}; LOCAL_COVERS={sum(bool(r['thumbnail']) for r in kept)}; EXCLUDED_UNREACHABLE={sum(r is None for r,_ in results)}")
