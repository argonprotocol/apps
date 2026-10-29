FROM certbot/certbot:v5.3.0@sha256:63f918e44ae3b85c45549104d99b3121ad57435a67054030c3e829a3fbf36b34

COPY entrypoint.sh /usr/local/bin/argon-gateway-certbot
RUN chmod +x /usr/local/bin/argon-gateway-certbot

ENTRYPOINT ["/usr/local/bin/argon-gateway-certbot"]
