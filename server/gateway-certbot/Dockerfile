FROM certbot/certbot:v5.3.0

COPY entrypoint.sh /usr/local/bin/argon-gateway-certbot
RUN chmod +x /usr/local/bin/argon-gateway-certbot

ENTRYPOINT ["/usr/local/bin/argon-gateway-certbot"]
