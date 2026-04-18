import { Injectable } from '@nestjs/common';
import { UsersService } from 'src/user/user.service';
import { text } from 'stream/consumers';

@Injectable()
export class TweetService {
    constructor(private readonly userService: UsersService){}
 


    getAllTweets() {
        
    }

    getTweetsByUserId(userId: number) {
      

    }
}
