import { forwardRef, Inject, Injectable } from "@nestjs/common";

import { Repository } from "typeorm";
import { User } from "./user.entity";
import { InjectRepository} from "@nestjs/typeorm"
import { CreateUserDTO } from "./dto/create-user.dto";

@Injectable()
export class UsersService {
  

constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>){}

getAllUsers() {
    
     return this.userRepository.find();
}

public async createUser(user: CreateUserDTO) {
   const existed_user = await this.userRepository.findOne({where:{email:user.email}});
    if(existed_user){
     throw new Error('User with this email already exists');
    }
   const new_user = await this.userRepository.create(user);
    return this.userRepository.save(new_user);
}
}