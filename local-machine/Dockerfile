FROM jrei/systemd-ubuntu:25.04

ARG SSH_PUBKEY

RUN sed -i 's/noble/plucky/g' /etc/apt/sources.list.d/ubuntu.sources && \
    apt-get update && \
    apt-get install -y --no-install-recommends openssh-server sudo ufw netcat-openbsd

RUN mkdir -p /run/sshd
# disable policy-rc.d to allow service start
RUN rm -f /usr/sbin/policy-rc.d && \
    systemctl mask getty@tty1.service

RUN useradd -ms /bin/bash argon \
 && echo "argon ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

# Update sshd_config
RUN sed -i 's/#\?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config && \
    sed -i 's/#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config && \
    sed -i 's/#\?PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config && \
    sed -i 's/#\?UsePAM.*/UsePAM yes/' /etc/ssh/sshd_config && \
    echo "AllowUsers root argon" >> /etc/ssh/sshd_config && \
    echo "ClientAliveInterval 120" >> /etc/ssh/sshd_config && \
    sed -i '/pam_nologin.so/d' /etc/pam.d/sshd


RUN mkdir -p /home/argon/.ssh && \
    echo "$SSH_PUBKEY" > /home/argon/.ssh/authorized_keys && \
    chown -R argon:argon /home/argon/.ssh && \
    chmod 700 /home/argon/.ssh && \
    chmod 600 /home/argon/.ssh/authorized_keys && \
    mkdir -p /root/.ssh && \
    cp /home/argon/.ssh/authorized_keys /root/.ssh/authorized_keys && \
    chmod 600 /root/.ssh/authorized_keys

RUN systemctl enable ssh

EXPOSE 22
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["/lib/systemd/systemd"]
