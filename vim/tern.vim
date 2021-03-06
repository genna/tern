py << endpy

import vim, os, platform, subprocess, urllib2, webbrowser, json, re, select, time

def tern_displayError(err):
  vim.command("echomsg " + json.dumps(str(err)))

def tern_makeRequest(port, doc):
  try:
    req = urllib2.urlopen("http://localhost:" + str(port) + "/", json.dumps(doc), 1)
    return json.loads(req.read())
  except urllib2.HTTPError, error:
    tern_displayError(error.read())
    return None

def tern_projectDir():
  cur = vim.eval("b:ternProjectDir")
  if cur: return cur

  projectdir = ""
  mydir = vim.eval("expand('%:p:h')")
  if not os.path.isdir(mydir): return ""

  if mydir:
    projectdir = mydir
    while True:
      parent = os.path.dirname(mydir[:-1])
      if not parent:
        break
      if os.path.isfile(os.path.join(mydir, ".tern-project")):
        projectdir = mydir
        break
      mydir = parent

  vim.command("let b:ternProjectDir = " + json.dumps(projectdir))
  return projectdir

def tern_findServer(ignorePort=False):
  cur = int(vim.eval("b:ternPort"))
  if cur != 0 and cur != ignorePort: return (cur, True)

  dir = tern_projectDir()
  if not dir: return (None, False)
  portFile = os.path.join(dir, ".tern-port")
  if os.path.isfile(portFile):
    port = int(open(portFile, "r").read())
    if port != ignorePort:
      vim.command("let b:ternPort = " + str(port))
      return (port, True)
  return (tern_startServer(), False)

def tern_startServer():
  win = platform.system() == "Windows"
  pdir = tern_projectDir()
  proc = subprocess.Popen(vim.eval("g:tern#command"), cwd=pdir,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=win)
  output = ""

  if not win:
    fds = [proc.stdout, proc.stderr]
    while len(fds):
      ready = select.select(fds, [], [], .4)[0]
      if not len(ready): break
      line = ready[0].readline()
      if not line:
        fds.remove(ready[0])
        continue
      match = re.match("Listening on port (\\d+)", line)
      if match:
        port = int(match.group(1))
        vim.command("let b:ternPort = " + str(port))
        return port
      else:
        output += line
  else:
    # The relatively sane approach above doesn't work on windows, so
    # we poll for the file
    portFile = os.path.join(pdir, ".tern-port")
    slept = 0
    while True:
      if os.path.isfile(portFile): return int(open(portFile, "r").read())
      if slept > 8: break
      time.sleep(.05)
      slept += 1
    output = proc.stderr.read() + proc.stdout.read()

  tern_displayError("Failed to start server" + (output and ":\n" + output))
  return None

def tern_relativeFile():
  filename = vim.eval("expand('%:p')")
  return filename[len(tern_projectDir()) + 1:]

def tern_bufferSlice(buf, pos, end):
  text = ""
  while pos < end:
    text += buf[pos] + "\n"
    pos += 1
  return text

def tern_fullBuffer():
  return {"type": "full",
          "name": tern_relativeFile(),
          "text": tern_bufferSlice(vim.current.buffer, 0, len(vim.current.buffer))}

def tern_bufferFragment():
  curRow, curCol = vim.current.window.cursor
  line = curRow - 1
  buf = vim.current.buffer
  minIndent = None
  start = None

  for i in range(max(0, line - 50), line):
    if not re.match(".*\\bfunction\\b", buf[i]): continue
    indent = len(re.match("^\\s*", buf[i]).group(0))
    if minIndent is None or indent <= minIndent:
      minIndent = indent
      start = i

  if start is None: start = max(0, line - 50)
  end = min(len(buf) - 1, line + 20)
  return {"type": "part",
          "name": tern_relativeFile(),
          "text": tern_bufferSlice(buf, start, end),
          "offsetLines": start}

def tern_runCommand(query, pos=None, fragments=True):
  if isinstance(query, str): query = {"type": query}
  if (pos is None):
    curRow, curCol = vim.current.window.cursor
    pos = {"line": curRow - 1, "ch": curCol}
  port, portIsOld = tern_findServer()
  if port is None: return
  curSeq = vim.eval("undotree()['seq_cur']")

  doc = {"query": query, "files": []}
  if curSeq == vim.eval("b:ternBufferSentAt"):
    fname, sendingFile = (tern_relativeFile(), False)
  elif len(vim.current.buffer) > 250 and fragments:
    f = tern_bufferFragment()
    doc["files"].append(f)
    pos = {"line": pos["line"] - f["offsetLines"], "ch": pos["ch"]}
    fname, sendingFile = ("#0", False)
  else:
    doc["files"].append(tern_fullBuffer())
    fname, sendingFile = ("#0", True)
  query["file"] = fname
  query["end"] = pos
  query["lineCharPositions"] = True

  data = None
  try:
    data = tern_makeRequest(port, doc)
    if data is None: return None
  except:
    pass

  if data is None and portIsOld:
    try:
      port, portIsOld = tern_findServer(port)
      if port is None: return
      data = tern_makeRequest(port, doc)
      if data is None: return None
    except Exception as e:
      tern_displayError(e)

  if sendingFile and vim.eval("b:ternInsertActive") == "0":
    vim.command("let b:ternBufferSentAt = " + str(curSeq))
  return data

def tern_sendBuffer():
  port, _portIsOld = tern_findServer()
  if port is None: return False
  try:
    tern_makeRequest(port, {"files": [tern_fullBuffer()]})
    return True
  except:
    return False

def tern_sendBufferIfDirty():
  if (vim.eval("exists('b:ternInsertActive')") == "1" and
      vim.eval("b:ternInsertActive") == "0"):
    curSeq = vim.eval("undotree()['seq_cur']")
    if curSeq > vim.eval("b:ternBufferSentAt") and tern_sendBuffer():
      vim.command("let b:ternBufferSentAt = " + str(curSeq))

def tern_asCompletionIcon(type):
  if type is None or type == "?": return "(?)"
  if type.startswith("fn("): return "(fn)"
  if type.startswith("["): return "([])"
  if type == "number": return "(num)"
  if type == "string": return "(str)"
  if type == "bool": return "(bool)"
  return "(obj)"

def tern_ensureCompletionCached():
  cached = vim.eval("b:ternLastCompletionPos")
  curRow, curCol = vim.current.window.cursor
  curLine = vim.current.buffer[curRow - 1]

  if (curRow == int(cached["row"]) and curCol >= int(cached["end"]) and
      curLine[int(cached["start"]):int(cached["end"])] == cached["word"] and
      (not re.match(".*\\W", curLine[int(cached["end"]):curCol]))):
    return

  data = tern_runCommand({"type": "completions", "types": True, "docs": True},
                         {"line": curRow - 1, "ch": curCol})
  if data is None: return

  completions = []
  for rec in data["completions"]:
    completions.append({"word": rec["name"],
                        "menu": tern_asCompletionIcon(rec.get("type")),
                        "info": tern_typeDoc(rec) })
  vim.command("let b:ternLastCompletion = " + json.dumps(completions))
  start, end = (data["start"]["ch"], data["end"]["ch"])
  vim.command("let b:ternLastCompletionPos = " + json.dumps({
    "row": curRow,
    "start": start,
    "end": end,
    "word": curLine[start:end]
  }))

def tern_typeDoc(rec):
  tp = rec.get("type")
  result = rec.get("doc", " ")
  if tp and tp != "?":
     result = tp + "\n" + result
  return result

def tern_lookupDocumentation(browse=False):
  data = tern_runCommand("documentation")
  if data is None: return

  doc = data.get("doc")
  url = data.get("url")
  if url:
    if browse: return webbrowser.open(url)
    doc = ((doc and doc + "\n\n") or "") + "See " + url
  if doc:
    vim.command("call tern#PreviewInfo(" + json.dumps(doc) + ")")
  else:
    vim.command("echo 'no documentation found'")

def tern_lookupType():
  data = tern_runCommand("type")
  if data: vim.command("echo " + json.dumps(data.get("type", "not found")))

def tern_lookupDefinition(cmd):
  data = tern_runCommand("definition")
  if data is None: return

  if "file" in data:
    vim.command(cmd + " +" + str(data["start"]["line"] + 1) + " " + data["file"])
  elif "url" in data:
    vim.command("echo " + json.dumps("see " + data["url"]))
  else:
    vim.command("echo 'no definition found'")

def tern_refs():
  data = tern_runCommand("refs", fragments=False)
  if data is None: return

  refs = []
  for ref in data["refs"]:
    lnum     = ref["start"]["line"] + 1
    col      = ref["start"]["ch"] + 1
    filename = ref["file"]
    name     = data["name"]
    text     = vim.eval("getbufline('" + filename + "'," + str(lnum) + ")")
    refs.append({"lnum": lnum,
                 "col": col,
                 "filename": filename,
                 "text": name + " (file not loaded)" if len(text)==0 else text[0]})
  vim.command("call setloclist(0," + json.dumps(refs) + ") | lopen")

endpy

if !exists('g:tern#command')
  let g:tern#command = ["node", expand('<sfile>:h') . '/../bin/tern']
endif

function! tern#PreviewInfo(info)
  pclose
  new +setlocal\ previewwindow|setlocal\ buftype=nofile|setlocal\ noswapfile
  exe "normal z" . &previewheight . "\<cr>"
  call append(0, type(a:info)==type("") ? split(a:info, "\n") : a:info)
  wincmd p
endfunction

function! tern#Complete(findstart, complWord)
  if a:findstart
    python tern_ensureCompletionCached()
    return b:ternLastCompletionPos['start']
  elseif b:ternLastCompletionPos['end'] - b:ternLastCompletionPos['start'] == len(a:complWord)
    return b:ternLastCompletion
  else
    let rest = []
    for entry in b:ternLastCompletion
      if stridx(entry["word"], a:complWord) == 0
        call add(rest, entry)
      endif
    endfor
    return rest
  endif
endfunction

command! TernDoc py tern_lookupDocumentation()
command! TernDocBrowse py tern_lookupDocumentation(browse=True)
command! TernType py tern_lookupType()
command! TernDef py tern_lookupDefinition("edit")
command! TernDefPreview py tern_lookupDefinition("pedit")
command! TernDefSplit py tern_lookupDefinition("split")
command! TernDefTab py tern_lookupDefinition("tabe")
command! TernRefs py tern_refs()

function! tern#Enable()
  if stridx(&buftype, "nofile") > -1 || stridx(&buftype, "nowrite") > -1
    return
  endif
  let b:ternPort = 0
  let b:ternProjectDir = ''
  let b:ternLastCompletion = []
  let b:ternLastCompletionPos = {'row': -1, 'start': 0, 'end': 0}
  let b:ternBufferSentAt = -1
  let b:ternInsertActive = 0
  setlocal omnifunc=tern#Complete
endfunction

autocmd FileType javascript :call tern#Enable()
autocmd BufLeave *.js :py tern_sendBufferIfDirty()
autocmd InsertEnter *.js :if exists('b:ternInsertActive')|let b:ternInsertActive = 1|endif
autocmd InsertLeave *.js :if exists('b:ternInsertActive')|let b:ternInsertActive = 0|endif
