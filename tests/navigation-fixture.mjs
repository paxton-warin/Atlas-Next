export async function navigationFixture(req, res, url) {
  if (!url.pathname.startsWith("/navigation")) return false;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (url.pathname === "/navigation/upload") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const passed =
      req.method === "POST" &&
      req.headers["content-type"]?.startsWith("multipart/form-data;") &&
      body.includes('name="choice"') &&
      body.includes("selected") &&
      body.includes('filename="fixture.txt"') &&
      body.includes("fixture upload contents");
    res.end(`<h1>Upload ${passed ? "retained" : "lost"}</h1>`);
    return true;
  }
  if (url.pathname === "/navigation/finish") {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (body !== "proof=fixture-callback") {
      res.writeHead(400);
      res.end("Missing callback body");
      return true;
    }
    res.writeHead(303, {
      Location: "/navigation/done?q=kept",
      "Set-Cookie":
        "navigation_fixture=complete; HttpOnly; Path=/; SameSite=Lax",
    });
    res.end();
    return true;
  }
  if (url.pathname === "/navigation/done") {
    res.end(
      `<h1>Redirect complete</h1><p id="cookie">${req.headers.cookie?.includes("navigation_fixture=complete") ? "Cookie retained" : "Cookie missing"}</p>`,
    );
    return true;
  }
  if (url.pathname === "/navigation/results") {
    res.end(
      `<h1>Search results</h1><p id="query">${(url.searchParams.get("q") || "").replaceAll("<", "&lt;")}</p>`,
    );
    return true;
  }
  if (url.pathname === "/navigation/popup") {
    res.end(
      `<!doctype html><title>Sign-in fixture</title><h1>Sign-in fixture</h1><button id="finish">Finish sign-in fixture</button><script>document.getElementById('finish').onclick=()=>{if(opener){opener.postMessage('fixture-signed-in',location.origin);window.close()}}</script>`,
    );
    return true;
  }
  if (url.pathname === "/navigation/nested") {
    res.end(
      `<input aria-label="Nested input"><button onclick="parent.postMessage('fixture-verified',location.origin)">Complete callback fixture</button>`,
    );
    return true;
  }
  res.end(`<!doctype html><title>Navigation fixture</title><h1>Navigation fixture</h1>
    <form action="/navigation/results" method="GET"><input aria-label="Website search" name="q"><button>Search website</button></form>
    <form id="callback" action="/navigation/finish" target="_top" method="POST"><input type="hidden" name="proof" value="fixture-callback"></form>
    <iframe title="Nested callback fixture" src="/navigation/nested"></iframe>
    <a href="/navigation/popup" target="_blank">Link popup</a>
    <form target="_blank" action="/navigation/finish" method="POST"><input type="hidden" name="proof" value="fixture-callback"><button>Submit popup form</button></form>
    <form action="/navigation/results" method="GET"><input type="file" name="attachment" aria-label="Popup attachment"><button formtarget="_blank" formaction="/navigation/upload" formmethod="POST" formenctype="multipart/form-data" name="choice" value="selected">Upload popup form</button></form>
    <button onclick="window.open('/navigation/popup','_blank','noopener')===null&&(document.getElementById('popup-result').textContent='No opener handle')">No-opener popup</button>
    <button id="open">Open sign-in popup</button><button id="blank">Open blank then navigate</button><button id="assign">Open blank then assign</button><button id="replace">Open blank then replace</button><button id="reuse">Reuse named popup</button>
    <p id="popup-result"></p><p id="closed-result"></p>
    <script>let popup;
    document.getElementById('open').onclick=()=>{popup=window.open('/navigation/popup','atlas-fixture-login','width=420,height=500')};
    document.getElementById('blank').onclick=()=>{popup=window.open('','atlas-fixture-login');setTimeout(()=>popup.location.href='/navigation/popup',25)};
    document.getElementById('assign').onclick=()=>{popup=window.open('','atlas-fixture-login');setTimeout(()=>popup.location.assign('/navigation/popup'),25)};
    document.getElementById('replace').onclick=()=>{popup=window.open('','atlas-fixture-login');setTimeout(()=>popup.location.replace('/navigation/popup'),25)};
    document.getElementById('reuse').onclick=()=>{popup=window.open('/navigation/popup','atlas-fixture-login');popup.focus()};
    addEventListener('message',e=>{if(e.origin!==location.origin)return;if(e.data==='fixture-verified')document.getElementById('callback').submit();if(e.data==='fixture-signed-in'){document.getElementById('popup-result').textContent='Opener message received';setTimeout(()=>document.getElementById('closed-result').textContent=popup.closed?'Popup closed':'Popup still open',100)}});
    </script>`);
  return true;
}
