FROM alpine:3.21
RUN apk add --no-cache ttyd bash
EXPOSE 7681
CMD ["ttyd", "-W", "--hostname", "*", "--origin", "*", "bash"]
