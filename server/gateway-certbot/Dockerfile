FROM certbot/certbot:v5.9.0@sha256:bc93cb710b413e6b456d622f9b0133b3e109c0a78c2ed9976af43d209b0a1805

RUN apk add --no-cache --upgrade 'openssl>=3.5.9-r1'

COPY entrypoint.sh /usr/local/bin/argon-gateway-certbot
RUN chmod +x /usr/local/bin/argon-gateway-certbot

ENTRYPOINT ["/usr/local/bin/argon-gateway-certbot"]
