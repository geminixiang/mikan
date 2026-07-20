import asyncio
import os
import signal
import urllib.parse
from pathlib import Path

from fastapi import FastAPI, File, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

WORKSPACE = Path("/workspace")


class ExecuteRequest(BaseModel):
    command: str


class ExecuteResponse(BaseModel):
    stdout: str
    stderr: str
    exit_code: int


app = FastAPI(title="mikan Agent Sandbox Runtime", version="1")


@app.get("/")
async def health_check():
    return {"status": "ok"}


@app.post("/execute", response_model=ExecuteResponse)
async def execute(body: ExecuteRequest, request: Request):
    try:
        process = await asyncio.create_subprocess_exec(
            "bash",
            "-lc",
            body.command,
            cwd=WORKSPACE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
        communicate = asyncio.create_task(process.communicate())
        while not communicate.done():
            if await request.is_disconnected():
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    await asyncio.wait_for(process.wait(), timeout=5)
                except TimeoutError:
                    os.killpg(process.pid, signal.SIGKILL)
                    await process.wait()
                communicate.cancel()
                return ExecuteResponse(stdout="", stderr="command cancelled", exit_code=130)
            await asyncio.sleep(0.1)
        stdout, stderr = await communicate
        return ExecuteResponse(
            stdout=stdout.decode(errors="replace"),
            stderr=stderr.decode(errors="replace"),
            exit_code=process.returncode,
        )
    except Exception as error:
        return ExecuteResponse(stdout="", stderr=str(error), exit_code=1)


def absolute_path(encoded_path: str) -> Path:
    decoded = urllib.parse.unquote(encoded_path)
    if not decoded or "\x00" in decoded:
        raise ValueError("invalid path")
    path = Path(decoded)
    return path if path.is_absolute() else WORKSPACE / path


@app.post("/upload")
async def upload(file: UploadFile = File(...)):
    try:
        path = absolute_path(file.filename or "")
        path.parent.mkdir(parents=True, exist_ok=True)
        staging = path.with_name(f".{path.name}.mikan-upload-{os.getpid()}")
        try:
            with staging.open("wb") as output:
                while chunk := await file.read(1024 * 1024):
                    output.write(chunk)
            staging.replace(path)
        finally:
            staging.unlink(missing_ok=True)
        return {"message": "uploaded"}
    except ValueError as error:
        return JSONResponse(status_code=400, content={"message": str(error)})
    except Exception as error:
        return JSONResponse(status_code=500, content={"message": str(error)})


@app.get("/download/{encoded_path:path}")
async def download(encoded_path: str):
    try:
        path = absolute_path(encoded_path)
    except ValueError as error:
        return JSONResponse(status_code=400, content={"message": str(error)})
    if not path.is_file():
        return JSONResponse(status_code=404, content={"message": "file not found"})
    return FileResponse(path, media_type="application/octet-stream", filename=path.name)


@app.get("/list/{encoded_path:path}")
async def list_files(encoded_path: str):
    try:
        path = absolute_path(encoded_path)
    except ValueError as error:
        return JSONResponse(status_code=400, content={"message": str(error)})
    if not path.is_dir():
        return JSONResponse(status_code=404, content={"message": "directory not found"})
    return [
        {
            "name": entry.name,
            "size": entry.stat().st_size,
            "type": "directory" if entry.is_dir() else "file",
            "mod_time": entry.stat().st_mtime,
        }
        for entry in path.iterdir()
    ]


@app.get("/exists/{encoded_path:path}")
async def exists(encoded_path: str):
    try:
        path = absolute_path(encoded_path)
    except ValueError as error:
        return JSONResponse(status_code=400, content={"message": str(error)})
    return {"path": urllib.parse.unquote(encoded_path), "exists": path.exists()}
