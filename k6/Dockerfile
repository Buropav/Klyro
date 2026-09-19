FROM grafana/k6:latest

USER root
RUN apk add --no-cache aws-cli

COPY load-script.js /k6/load-script.js
COPY run-and-upload.sh /k6/run-and-upload.sh
RUN chmod +x /k6/run-and-upload.sh

ENTRYPOINT ["/k6/run-and-upload.sh"]
