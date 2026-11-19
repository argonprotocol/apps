FROM nginx:1.30.7-alpine3.24@sha256:bef154735288bc38d99fac41ae63730684bcc661503673a04a0f9bc526ba8598

RUN apk upgrade --no-cache && \
    apk add --no-cache curl jq

COPY templates /etc/nginx/templates
COPY entrypoint.sh /usr/local/bin/argon-nginx-entrypoint
RUN chmod +x /usr/local/bin/argon-nginx-entrypoint

ENTRYPOINT ["/usr/local/bin/argon-nginx-entrypoint"]
CMD ["nginx", "-g", "daemon off;"]
