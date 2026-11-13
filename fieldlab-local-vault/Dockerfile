FROM python:3.13-alpine
WORKDIR /app
RUN apk add --no-cache openssl
COPY app/server.py /app/server.py
COPY app/cert_setup.py /app/cert_setup.py
COPY app/web /app/web
COPY entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh
USER 1000:1000
EXPOSE 8080 8449
ENTRYPOINT ["/entrypoint.sh"]
