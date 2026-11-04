FROM nginx:1.30.6-alpine3.24@sha256:0e52bd054126cdc040b1276c0af347aeb02a41b9cfe305d6094767ac30e97949

RUN apk upgrade --no-cache && \
    apk add --no-cache curl jq

COPY templates /etc/nginx/templates
COPY entrypoint.sh /usr/local/bin/argon-nginx-entrypoint
RUN chmod +x /usr/local/bin/argon-nginx-entrypoint

ENTRYPOINT ["/usr/local/bin/argon-nginx-entrypoint"]
CMD ["nginx", "-g", "daemon off;"]
