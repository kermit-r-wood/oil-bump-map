@echo off
echo Installing dependencies...
if not exist venv (
    python -m venv venv
)
call venv\Scripts\activate
pip install -r requirements.txt

echo.
echo Starting FastAPI server...
uvicorn app:app --host 127.0.0.1 --port 8000
