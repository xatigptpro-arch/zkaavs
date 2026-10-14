#!/bin/sh
set -eu
# Only ZKAAVS bridges enter these chains; other projects keep their rules.
iptables -w -N ZKAAVS-HOST 2>/dev/null || true
iptables -w -F ZKAAVS-HOST
iptables -w -A ZKAAVS-HOST -i br-zkaavs-api -j REJECT
iptables -w -A ZKAAVS-HOST -i br-zkaavs-out -j REJECT
iptables -w -A ZKAAVS-HOST -i br-zkaavs-canva -j REJECT
iptables -w -A ZKAAVS-HOST -j RETURN
iptables -w -C INPUT -j ZKAAVS-HOST 2>/dev/null || iptables -w -I INPUT 1 -j ZKAAVS-HOST

iptables -w -N ZKAAVS-NET 2>/dev/null || true
iptables -w -F ZKAAVS-NET
iptables -w -A ZKAAVS-NET -i br-zkaavs-api -s 172.30.240.5 -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
iptables -w -A ZKAAVS-NET -i br-zkaavs-api -s 172.30.240.5 -d 172.30.240.4 -p tcp --dport 3500 -j RETURN
iptables -w -A ZKAAVS-NET -i br-zkaavs-api -s 172.30.240.5 -j REJECT
iptables -w -A ZKAAVS-NET -i br-zkaavs-api -s 172.30.240.2 -d 172.30.240.5 -j REJECT
iptables -w -A ZKAAVS-NET -i br-zkaavs-api -s 172.30.240.3 -d 172.30.240.4 -j REJECT
iptables -w -A ZKAAVS-NET -i br-zkaavs-api -s 172.30.240.4 -d 172.30.240.5 -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
iptables -w -A ZKAAVS-NET -i br-zkaavs-api -s 172.30.240.4 -d 172.30.240.5 -j REJECT
iptables -w -A ZKAAVS-NET -i br-zkaavs-api -s 172.30.240.4 -d 172.30.240.2 -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
iptables -w -A ZKAAVS-NET -i br-zkaavs-api -s 172.30.240.4 -d 172.30.240.2 -j REJECT
iptables -w -A ZKAAVS-NET -i br-zkaavs-api -s 172.30.240.4 -d 172.30.240.3 -j REJECT
iptables -w -A ZKAAVS-NET -i br-zkaavs-api -s 172.30.240.2 -d 172.30.240.4 -j REJECT
iptables -w -A ZKAAVS-NET -i br-zkaavs-api -o br-zkaavs-api -j RETURN
iptables -w -A ZKAAVS-NET -i br-zkaavs-out -o br-zkaavs-out -j RETURN
iptables -w -A ZKAAVS-NET -i br-zkaavs-canva -o br-zkaavs-canva -j RETURN
# Cloudflare Tunnel endpoint ranges, outbound TCP/UDP 7844 only.
for destination in 198.41.192.0/24 198.41.200.0/24; do
  for protocol in tcp udp; do
    iptables -w -A ZKAAVS-NET -i br-zkaavs-out -d "$destination" -p "$protocol" --dport 7844 -j RETURN
  done
done
iptables -w -A ZKAAVS-NET -i br-zkaavs-api -j REJECT
iptables -w -A ZKAAVS-NET -i br-zkaavs-out -j REJECT
for destination in 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 224.0.0.0/4; do
  iptables -w -A ZKAAVS-NET -i br-zkaavs-canva -d "$destination" -j REJECT
done
iptables -w -A ZKAAVS-NET -i br-zkaavs-canva -p tcp --dport 443 -j RETURN
iptables -w -A ZKAAVS-NET -i br-zkaavs-canva -j REJECT
iptables -w -A ZKAAVS-NET -o br-zkaavs-api -j REJECT
iptables -w -A ZKAAVS-NET -o br-zkaavs-out -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
iptables -w -A ZKAAVS-NET -o br-zkaavs-out -j REJECT
iptables -w -A ZKAAVS-NET -i tailscale0 -o br-zkaavs-canva -d 172.30.242.2 -p tcp --dport 5902 -j RETURN
iptables -w -A ZKAAVS-NET -o br-zkaavs-canva -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
iptables -w -A ZKAAVS-NET -o br-zkaavs-canva -j REJECT
iptables -w -A ZKAAVS-NET -j RETURN
iptables -w -C DOCKER-USER -j ZKAAVS-NET 2>/dev/null || iptables -w -I DOCKER-USER 1 -j ZKAAVS-NET
