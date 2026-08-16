FROM python:3-slim

COPY . /app

WORKDIR /app

EXPOSE 8080

CMD ["python", "app.py", "--server-port", "8080"]
