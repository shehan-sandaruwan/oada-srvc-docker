#! /bin/sh

# If the SSL certs don't exist, nginx won't start. So use the 
# localhost ones and see if that will start it:
if [ -e "/certs/$DOMAIN" ]; then
  echo "Domain certs exist, moving on to main command"
else
  echo "Domain certs do not exist, temporarily copying localhost ones there"
  cp -rf /certs/localhost /certs/$DOMAIN
fi

# NOTE: the envsubst command below MUST have single quotes to
# prevent the shell replacing the variables in the string

chmod u+x /code/proxy/wait-for-it.sh && \
#  /code/proxy/wait-for-it.sh arangodb:8529 -t 0 && \
#  /code/proxy/wait-for-it.sh zookeeper:2181 -t 0 && \
#  /code/proxy/wait-for-it.sh kafka:9092 -t 0 && \
#  /code/proxy/wait-for-it.sh auth:80 -t 0 && \
#  /code/proxy/wait-for-it.sh well-known:80 -t 0 && \
#  /code/proxy/wait-for-it.sh http-handler:80 -t 0 && \
  mkdir -p /etc/nginx/sites-enabled && \
  echo "Setting DOMAIN = ${DOMAIN}" && \
  envsubst '${DOMAIN}' < /etc/nginx/sites-templates/localhost && \
  envsubst '${DOMAIN}' < /etc/nginx/sites-templates/localhost > /etc/nginx/sites-enabled/${DOMAIN}
  nginx -g 'daemon off;'
#  nginx-debug -g 'daemon off;'
