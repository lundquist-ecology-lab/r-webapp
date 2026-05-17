FROM alpine:3.21
RUN apk add --no-cache bash ip6tables tini wget R lm-sensors
RUN adduser -D -h /home/webterm -s /bin/bash webterm



# Download the correct ttyd binary for x86_64 Linux
RUN wget -q https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 -O /usr/local/bin/ttyd && \
    chmod +x /usr/local/bin/ttyd

USER webterm
WORKDIR /home/webterm
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/usr/local/bin/ttyd", "-W", "--no-auth", "bash", "-l"]
