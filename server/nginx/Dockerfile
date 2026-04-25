FROM nginx:1.27-alpine

RUN apk add --no-cache curl jq

COPY templates /etc/nginx/templates
COPY entrypoint.sh /usr/local/bin/argon-nginx-entrypoint
RUN chmod +x /usr/local/bin/argon-nginx-entrypoint

ENTRYPOINT ["/usr/local/bin/argon-nginx-entrypoint"]
CMD ["nginx", "-g", "daemon off;"]
